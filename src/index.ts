import { request } from "@octokit/request";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, ModelMessage, TextPart, UserContent } from "ai";
import { redis } from "bun";
import { load } from "cheerio";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { Elysia, status, t } from "elysia";
import net from "net";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.guess();

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
});

const app = new Elysia()
  .get("/", () => "Hello Elysia")
  .post(
    "/",
    async ({ body }) => {
      let { qq, group, msg, ref, image } = body;

      const snapshot = { qq, group, msg, ref, image: image?.slice(0, 42) };
      console.log(JSON.stringify(snapshot));

      let name = "";
      // /[name]
      if (msg.startsWith("/")) {
        const match = msg.match(/\/([^\s#<>]+)\s*(.*)/s);
        if (!match) throw status(400, "invalid / command");
        [, name, msg] = match;
      }
      const chain: string[] = [name];

      const tags = new Set<string>();
      const labels = new Map<string, string | null>();
      // #<tags>
      while (msg.startsWith("#")) {
        const match = msg.match(/#([^\s<>]+)\s*(.*)/s);
        if (!match) throw status(400, "invalid # command");
        [, , msg] = match;
        match[1].split("#").forEach((tag) => {
          if (tag.includes(":")) {
            const [key, value] = tag.split(":", 2);
            tags.add(key);
            labels.set(key, value);
          } else {
            tags.add(tag);
            labels.set(tag, null);
          }
        });
      }
      // > [msg]
      if (msg.startsWith(">")) {
        const match = msg.match(/>\s*(.*)/s);
        if (!match) throw status(400, "invalid > command");
        [, msg] = match;
        tags.add("context");
      }
      // < len > [msg]
      if (msg.startsWith("<")) {
        const match = msg.match(/<\s*(\d+)\s*>\s*(.*)/s);
        if (!match) throw status(400, "invalid <> command");
        [, , msg] = match;
        const len = match[1];
        tags.add("context");
        labels.set("context", len);
      }
      // tags
      if (msg === "tags") return Array.from(tags).join(", ");
      // labels
      if (msg === "labels")
        return Array.from(labels.entries())
          .map(([k, v]) => (v ? `${k}: ${v}` : k))
          .join("\n");

      // ref
      // set <key>
      if (msg.startsWith("set") && ref) {
        const match = msg.match(/set\s+(\S+)/s);
        if (!match) throw status(400, "invalid set command");
        const [, key] = match;
        await redis.set(`key:${key}`, ref);
        return `${key}: ${ref}`;
      }
      // set <key> <value>
      else if (msg.startsWith("set")) {
        const match = msg.match(/set\s+(\S+)\s+(.+)/s);
        if (!match) throw status(400, "invalid set command");
        const [, key, value] = match;
        await redis.set(`key:${key}`, value);
        return `${key}: ${value}`;
      }
      // ref
      // get
      else if (msg === "get" && ref) {
        const value = await redis.get(`key:${ref}`);
        if (!value) throw status(404, `key ${ref} not found`);
        return value;
      }
      // get <key>
      else if (msg.startsWith("get")) {
        const match = msg.match(/get\s+(\S+)/s);
        if (!match) throw status(400, "invalid get command");
        const [, key] = match;
        const value = await redis.get(`key:${key}`);
        if (!value) throw status(404, `key ${key} not found`);
        return value;
      }
      // echo [msg]
      else if (msg.startsWith("echo")) {
        // #image
        if (tags.has("image") && image) return image;
        // #ref
        if (tags.has("ref") && ref) return ref;
        const match = msg.match(/echo\s*(.*)/s);
        if (!match) throw status(400, "invalid echo command");
        [, msg] = match;
        return msg;
      }

      // 42
      if (msg.length >= 42) {
        // not a command
      }
      // ping
      else if (msg === "ping") return "pong";
      // snapshot
      else if (msg === "snapshot") return snapshot;
      // enable
      else if (msg.startsWith("enable")) {
        const match = msg.match(/enable\s+(\S+)/s);
        if (!match) throw status(400, "invalid enable command");
        const [, key] = match;
        return await redis.hset(`feature:${qq}`, key, "true");
      }
      // disable
      else if (msg.startsWith("disable")) {
        const match = msg.match(/disable\s+(\S+)/s);
        if (!match) throw status(400, "invalid disable command");
        const [, key] = match;
        return await redis.hset(`feature:${qq}`, key, "false");
      }
      // features
      else if (msg === "features") {
        // #reset
        if (tags.has("reset")) return await redis.del(`feature:${qq}`);

        const features = await redis.hgetall(`feature:${qq}`);

        // #raw
        if (tags.has("raw")) return features;

        return Object.entries(features)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n");
      }
      // rooms | r
      else if (msg === "rooms" || msg === "r") {
        const [main, beta] = await Promise.all([
          fetch("https://gi.xqm32.org/api/rooms").then((r) => r.json()),
          fetch("https://beta.gi.xqm32.org/api/rooms").then((r) => r.json()),
        ]);

        // #raw
        if (tags.has("raw")) return { main, beta };

        const format = (room: { id: number; players: { name: string }[] }) => {
          const { id, players } = room;
          const sides = players.map((player) => player.name).join(" 🆚 ");
          return `${id} 👉 ${sides}`;
        };
        return [
          "===== Main =====",
          ...main.map(format),
          "===== Beta =====",
          ...beta.map(format),
        ].join("\n");
      }
      // guyu | gy
      else if (msg === "guyu" || msg === "gy") {
        const { data } = await request("GET /repos/{owner}/{repo}/pulls", {
          owner: "genius-invokation",
          repo: "genius-invokation",
          state: "all",
          sort: "updated",
          direction: "desc",
          headers: {
            authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
        const [pull] = data;
        return `${pull.title}\n${pull.html_url}`;
      }
      // ip <address>
      else if (msg.startsWith("ip")) {
        const match = msg.match(/ip\s*(\S*)/s);
        if (!match) throw status(400, "invalid ip command");
        const [, host] = match;
        if (!net.isIP(host)) throw status(400, "invalid ip address");
        const url = new URL("https://ip.zxinc.org/api.php");
        url.searchParams.append("type", "json");
        url.searchParams.append("ip", host);
        const response = await fetch(url);
        const { data } = (await response.json()) as { data: unknown };
        const { location } = data as { location: string };
        return location;
      }
      // list models [filter]
      else if (msg.startsWith("list models")) {
        const match = msg.match(/list models\s*(.*)/s);
        if (!match) throw status(400, "invalid list models command");
        const [, filter] = match;
        const response = await fetch("https://openrouter.ai/api/v1/models", {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          },
        });

        interface Model {
          id: string;
          pricing: {
            prompt: string;
            completion: string;
          };
        }
        const { data: models } = (await response.json()) as {
          data: Model[];
        };

        // #raw
        if (tags.has("raw")) return models;

        const format = (price: string) =>
          (parseFloat(price) * 1_000_000).toPrecision(3);
        return models
          .filter((m) => m.id.includes(filter))
          .map((m) => {
            const { pricing } = m;
            const { prompt, completion } = pricing;
            if (tags.has("price"))
              return [
                m.id,
                `🤔 $${format(prompt)}/M`,
                `🤖 $${format(completion)}/M`,
              ].join("\n");
            return m.id;
          })
          .join("\n");
      }
      // <lol | cs>m [start] [end]
      else if (msg.startsWith("lolm") || msg.startsWith("csm")) {
        const match = msg.match(/(lol|cs)m\s*(\S*)\s*(\S*)/s);
        if (!match) throw status(400, "invalid m command");
        let [, game, start, end] = match;
        if (start.length === 0)
          start = dayjs().tz("Asia/Shanghai").format("YYYY-MM-DD");
        if (end.length === 0) end = start;

        const gid: Record<string, string> = { lol: "2", cs: "7" };
        const url = new URL("https://api.bilibili.com/x/esports/matchs/list");
        url.searchParams.append("mid", "0");
        url.searchParams.append("gid", gid[game]);
        url.searchParams.append("tid", "0");
        url.searchParams.append("pn", "1");
        url.searchParams.append("ps", "10");
        url.searchParams.append("contest_status", "");
        url.searchParams.append("stime", start);
        url.searchParams.append("etime", end);

        interface PlayerGradeDetail {
          nickname: string;
          grade_users: number;
          avg_grade: string;
          position: string;
        }
        interface Match {
          game_stage: string;
          stime: number;
          etime: number;
          home_score: number;
          away_score: number;
          season: { title: string };
          home: {
            name: string;
            player_grade_detail: PlayerGradeDetail[] | null;
          };
          away: {
            name: string;
            player_grade_detail: PlayerGradeDetail[] | null;
          };
        }
        const response = await fetch(url);
        const { data } = (await response.json()) as { data: unknown };
        const { list: matches } = data as { list: Match[] };
        const format = (match: Match) => {
          const start = dayjs
            .unix(match.stime)
            .tz("Asia/Shanghai")
            .format("YYYY-MM-DD HH:mm:ss");
          const end = dayjs
            .unix(match.etime)
            .tz("Asia/Shanghai")
            .format("YYYY-MM-DD HH:mm:ss");
          const lines = [
            `${match.season.title} ${match.game_stage}`,
            `${start} ~ ${end}`,
            `${match.home.name} ${match.home_score} - ${match.away_score} ${match.away.name}`,
          ];

          // #grade
          if (tags.has("grade")) {
            const { home, away } = match;
            const format = (detail: PlayerGradeDetail) => {
              const { nickname, position, avg_grade, grade_users } = detail;
              return `${nickname} ${position} ${avg_grade} (${grade_users})`;
            };
            if (home.player_grade_detail)
              home.player_grade_detail
                .map(format)
                .forEach((line) => lines.push(`${home.name} ${line}`));
            if (away.player_grade_detail)
              away.player_grade_detail
                .map(format)
                .forEach((line) => lines.push(`${away.name} ${line}`));
          }

          return lines.join("\n");
        };
        return matches.map(format).join("\n");
      }
      // 来点儿牌组 | 来点牌组 | 牌组 | decks | d
      else if (["来点儿牌组", "来点牌组", "牌组", "decks", "d"].includes(msg)) {
        const response = await fetch(
          "https://api-takumi.mihoyo.com/event/cardsquare/index",
          { method: "POST" }
        );
        const { data } = (await response.json()) as { data: unknown };

        interface Deck {
          nickname: string;
          title: string;
          tags: string[];
          card_code: string;
        }
        const { list: decks } = data as { list: Deck[] };

        return decks
          .map((deck) =>
            [
              `🎴 ${deck.title}`,
              `🎮 ${deck.nickname} 🏷️ ${deck.tags.join(", ")}`,
              `🃏 ${deck.card_code}`,
            ].join("\n")
          )
          .join("\n\n");
      }
      // usage
      else if (msg === "usage") {
        const value = await redis.get(`usage:${qq}:${group}:last`);
        if (!value) throw status(404, "usage not found");
        return Object.entries(JSON.parse(value))
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n");
      }

      const content: UserContent = [];
      if (image) {
        const url = URL.parse(image);
        if (url) content.push({ type: "image", image: url });
      }
      if (ref) content.push({ type: "text", text: ref });
      const messages: ModelMessage[] = [];

      // help
      if (msg.startsWith("help")) {
        const match = msg.match(/help\s*(.*)/s);
        if (!match) throw status(400, "invalid help command");
        [, msg] = match;
        tags.add("help");

        // / -> /help
        if (name.length === 0) chain.push("help");

        const { data } = (await request(
          "GET /repos/{owner}/{repo}/contents/{path}",
          {
            mediaType: { format: "raw" },
            owner: "xqm32",
            repo: "rachibot",
            path: "src/index.ts",
            headers: {
              authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
              "X-GitHub-Api-Version": "2022-11-28",
            },
          }
        )) as unknown as { data: string };
        content.push({ type: "text", text: data });
      }
      // credits
      else if (msg === "credits") {
        msg = "";
        tags.add("credits");

        const response = await fetch("https://openrouter.ai/api/v1/credits", {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          },
        });
        const text = await response.text();
        content.push({ type: "text", text });
      }
      // lol [filter] [start] [end]
      else if (msg.startsWith("lol")) {
        const match = msg.match(/lol\s*(\S*)\s*(\S*)\s*(\S*)/s);
        if (!match) throw status(400, "invalid lol command");
        let [, filter, start, end] = match;
        filter = filter.toLowerCase();

        let stime, etime;
        if (start.length === 0) stime = dayjs().tz("Asia/Shanghai");
        else stime = dayjs.tz(start, "Asia/Shanghai");
        if (end.length === 0) etime = stime;
        else etime = dayjs.tz(end, "Asia/Shanghai");

        const response = await fetch(
          "https://lpl.qq.com/web201612/data/LOL_MATCH2_GAME_LIST_BRIEF.js"
        );
        const text = await response.text();
        const {
          msg: { sGameList },
        } = JSON.parse(text.slice("var GameList=".length, -";".length)) as {
          msg: { sGameList: Record<string, unknown[]> };
        };

        interface Game {
          GameId: string;
          GameName: string;
          sDate: string;
          eDate: string;
        }
        const games = Object.values(sGameList).flat() as Game[];
        // sDate < stime < etime < eDate
        const gaming = games.filter((game) => {
          const sDate = dayjs.tz(game.sDate, "Asia/Shanghai").startOf("day");
          const eDate = dayjs.tz(game.eDate, "Asia/Shanghai").endOf("day");
          return (
            sDate.isBefore(stime.endOf("day")) &&
            eDate.isAfter(etime.startOf("day"))
          );
        });

        // #gaming
        if (tags.has("gaming"))
          return gaming
            .map((g) => `${g.GameName} ${g.sDate} ~ ${g.eDate}`)
            .join("\n");

        interface Match {
          bMatchId: string;
          bMatchName: string;
          GameName: string;
          GameModeName: string;
          GameTypeName: string;
          GameProcName: string;
          ScoreA: string;
          ScoreB: string;
          MatchDate: string;
        }
        const fetchMatch = async (game: Game) => {
          const response = await fetch(
            `https://lpl.qq.com/web201612/data/LOL_MATCH2_MATCH_HOMEPAGE_BMATCH_LIST_${game.GameId}.js`
          );
          if (!response.ok) return [];
          const { msg } = (await response.json()) as { msg: Match[] };
          return msg;
        };
        const formatMatch = (m: Match) => {
          const [a, b] = m.bMatchName.split(" vs ");
          return [
            `${m.GameName} ${m.GameTypeName} ${m.GameProcName} (${m.GameModeName})`,
            m.MatchDate,
            `${a} ${m.ScoreA} - ${m.ScoreB} ${b}`,
          ].join("\n");
        };
        const matches = (await Promise.all(gaming.map(fetchMatch))).flat();

        // lol <all> [start] [end]
        if (filter === "all") {
          // stime < mDate < etime
          const matching = matches.filter((match) => {
            const mDate = dayjs.tz(match.MatchDate, "Asia/Shanghai");
            return (
              mDate.isAfter(stime.startOf("day")) &&
              mDate.isBefore(etime.endOf("day"))
            );
          });
          return matching.map(formatMatch).join("\n");
        }

        // lol [filter] [start] [end]
        msg = "";
        tags.add("lol");

        // last match
        const last = matches
          .filter((match) => {
            const mDate = dayjs.tz(match.MatchDate, "Asia/Shanghai");
            if (!match.bMatchName.toLowerCase().includes(filter)) return false;
            // lol <filter>
            if (start.length === 0) return mDate.isBefore(etime);
            // lol <filter> <start> <end>
            return (
              mDate.isAfter(stime.startOf("day")) &&
              mDate.isBefore(etime.endOf("day"))
            );
          })
          .at(-1);
        if (!last) throw status(404, `match ${filter} not found`);

        // #last
        if (tags.has("last")) return formatMatch(last);

        // #news
        if (tags.has("news")) {
          const response = await fetch(
            `https://lpl.qq.com/web201612/data/LOL_MATCH_DETAIL_${last.bMatchId}.js`
          );
          const text = await response.text();
          const { sExt4 } = JSON.parse(
            text.slice("var dataObj=".length, -";".length)
          ) as { sExt4: string | null };
          if (!sExt4) throw status(404, "news not found");
          const news = JSON.parse(sExt4) as { title: string }[];
          return news.map((n) => n.title).join("\n");
        }

        const authorization = await redis.get("key:$lol");
        if (!authorization) throw status(403, "lol authorization not set");
        const fetchDetail = async (match: Match) => {
          const url = new URL(
            "https://open.tjstats.com/match-auth-app/open/v1/compound/matchDetail"
          );
          url.searchParams.append("matchId", match.bMatchId);
          const response = await fetch(url, { headers: { authorization } });
          const text = await response.text();
          return text;
        };
        const detail = await fetchDetail(last);

        // #detail
        if (tags.has("detail")) return detail;

        content.push({ type: "text", text: detail });
      }
      // hacker news [prompt]
      else if (msg.startsWith("hacker news")) {
        const match = msg.match(/hacker news\s*(.*)/s);
        if (!match) throw status(400, "invalid hacker news command");
        [, msg] = match;
        tags.add("hacker-news");

        const response = await fetch("https://news.ycombinator.com");
        const text = await response.text();
        content.push({ type: "text", text });
      }
      // github trending
      else if (msg === "github trending") {
        msg = "";
        tags.add("github-trending");

        const response = await fetch("https://github.com/trending");
        const text = await response.text();
        content.push({ type: "text", text });
      }
      // xkcd
      else if (msg.startsWith("xkcd")) {
        const match = msg.match(/xkcd\s*(\S*)\s*(.*)/s);
        if (!match) throw status(400, "invalid xkcd command");
        [, , msg] = match;
        const comic = match[1];
        tags.add("xkcd");

        let response;
        // #random
        if (tags.has("random")) {
          response = await fetch("https://c.xkcd.com/random/comic");
          tags.delete("random");
        }
        // xkcd [comic]
        else if (comic.length > 0)
          response = await fetch(`https://xkcd.com/${comic}`);
        // xkcd
        else response = await fetch("https://xkcd.com");

        const text = await response.text();
        const regex = /<meta property="og:image" content="([^"]*)">/;
        const meta = text.match(regex);
        if (!meta) throw status(500, "xkcd image not found");
        const [, url] = meta;

        // #image
        if (tags.has("image")) return url;

        content.push({ type: "image", image: new URL(url) });
      }
      // ref
      // ask
      else if (msg === "ask" && ref) {
        msg = "";
        tags.add("ask");

        let text = await redis.get(`key:$smart-questions`);
        if (!text) {
          const response = await fetch(
            "http://www.catb.org/~esr/faqs/smart-questions.html"
          );
          text = await response.text();
          await redis.set(`key:$smart-questions`, text);
          await redis.expire(`key:$smart-questions`, 86400);
        }
        content.push({ type: "text", text });
      }

      const regex = /https?:\/\/[^\s`]+/g;
      const links: Set<string> = new Set();
      ref?.match(regex)?.forEach((link) => links.add(link));
      msg.match(regex)?.forEach((link) => links.add(link));
      // #nolinks
      if (tags.has("nolinks")) tags.delete("nolinks");
      else if (links.size > 0) {
        // #links
        if (tags.has("links")) return Array.from(links).join("\n");

        tags.add("links");
        const parts = await Promise.all(
          Array.from(links).map(async (link) => {
            const response = await fetch(link);
            let text = await response.text();

            const featureCheerio = await redis.hget(`feature:${qq}`, "cheerio");
            if (featureCheerio === "true" || tags.has("cheerio")) {
              text = load(text).text();
              tags.delete("cheerio");
            }

            text = `<resource uri="${link}">\n${text}\n</resource>`;
            return { type: "text", text } as TextPart;
          })
        );
        content.push(...parts);
      }

      // /[name] -> ... -> /[provider/model]
      if (chain.length === 0) throw status(400, "no model specified");
      name = chain.at(-1)!;
      while (!name.includes("/")) {
        if (chain.length > 42) throw status(400, "too deep key chain");
        const value = await redis.get(`key:/${name}`);
        if (!value) {
          const keys = chain.map((v) => `/${v}`).join(" -> ");
          throw status(404, `key chain ${keys} not found`);
        }
        name = value;
        chain.push(name);
      }
      // name
      if (tags.has("name")) return name;
      // chain
      if (tags.has("chain")) return chain.map((v) => `/${v}`).join(" -> ");

      let context: ModelMessage[] = [];
      const featureContext = await redis.hget(`feature:${qq}`, "context");
      if (featureContext === "true" || tags.has("context")) {
        const value =
          labels.get("context") ??
          (await redis.hget(`feature:${qq}`, "length"));
        tags.delete("context");

        let length = 7;
        if (value) {
          const parsedValue = parseInt(value);
          if (parsedValue >= 0 && parsedValue <= 42) length = parsedValue;
          await redis.hset(`feature:${qq}`, "length", length.toString());
        }

        if (length > 0)
          context = (await redis.lrange(`context:${qq}:${group}`, -length, -1))
            .map((item) => JSON.parse(item) as ModelMessage[])
            .flat();
      }
      // context
      if (msg === "context") {
        // #raw
        if (tags.has("raw")) return context;

        return context
          .flatMap((m) => {
            if (typeof m.content === "string")
              return { role: m.role, content: m.content };
            return m.content
              .filter((part) => part.type === "text")
              .map((part) => ({ role: m.role, content: part.text }));
          })
          .map((m) => {
            const role = {
              system: "⚙️",
              user: "🤔",
              assistant: "🤖",
              tool: "🔧",
            }[m.role];

            // fine-structure constant
            const content = m.content
              .trim()
              .slice(0, 137)
              .split("\n")
              .at(0)
              ?.trim();

            return `${role} ${content}`;
          })
          .join("\n");
      }
      // clear
      if (msg === "clear") return await redis.del(`context:${qq}:${group}`);

      for (const tag of tags) {
        const value = await redis.get(`key:#${tag}`);
        if (!value) throw status(404, `key #${tag} not found`);
        messages.unshift({ role: "system", content: value });
      }

      // system
      // user [image, ref, msg]
      if (content.length > 0) messages.push({ role: "user", content });
      if (msg.length > 0) messages.push({ role: "user", content: msg });

      if (!messages.some((m) => m.role === "user"))
        throw status(400, "no user message");

      const model = openrouter(name);
      const { text, usage, response } = await generateText({
        model,
        messages: context.concat(messages),
      });
      const { modelId } = response;
      await redis.set(
        `usage:${qq}:${group}:last`,
        JSON.stringify({ modelId, ...usage })
      );
      await redis.rpush(
        `context:${qq}:${group}`,
        JSON.stringify(
          messages.concat(response.messages).filter((m) => m.role !== "system")
        )
      );
      await redis.ltrim(`context:${qq}:${group}`, -42, -1);
      await redis.expire(`context:${qq}:${group}`, 3600);
      return text;
    },
    {
      body: t.Object({
        qq: t.Optional(t.String()),
        group: t.Optional(t.String()),
        msg: t.String(),
        ref: t.Optional(t.String()),
        image: t.Optional(t.String()),
      }),
    }
  )
  .post("/api/v1/chat/completions", async ({ request }) => {
    const enabled = await redis.get("key:$/api/v1/chat/completions");
    if (enabled === "false") throw status(403, "endpoint disabled");
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: request.body,
      }
    );
    return new Response(response.body);
  })
  .listen(process.env.PORT ?? 3000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
