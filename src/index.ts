import { request } from "@octokit/request";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, ModelMessage, UserContent } from "ai";
import { redis } from "bun";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { Elysia, status, t } from "elysia";

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
      let { qq, msg, ref, image } = body;

      const snapshot = { qq, msg, ref, image: image?.slice(0, 42) };
      console.log(JSON.stringify(snapshot));

      // set <key> <value>
      if (msg.startsWith("set")) {
        const match = msg.match(/set\s+(\S+)\s+(.+)/s);
        if (!match) throw status(400, "invalid set command");
        const [, key, value] = match;
        await redis.set(`key:${key}`, value);
        return `${key}: ${value}`;
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

      // 42
      if (msg.length >= 42) {
        // not a command
      }
      // ping
      else if (msg === "ping") return "pong";
      // snapshot
      else if (msg === "snapshot") return snapshot;
      // rooms | r
      else if (msg === "rooms" || msg === "r") {
        const [main, beta] = await Promise.all([
          fetch("https://gi.xqm32.org/api/rooms").then((r) => r.json()),
          fetch("https://beta.gi.xqm32.org/api/rooms").then((r) => r.json()),
        ]);
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
        const { data: models } = (await response.json()) as {
          data: { id: string }[];
        };
        return models
          .filter((m) => m.id.includes(filter))
          .map((m) => m.id)
          .join("\n");
      }
      // <lol | cs> [start] [end]
      else if (msg.startsWith("lol") || msg.startsWith("cs")) {
        const match = msg.match(/(lol|cs)\s*(\S*)\s*(\S*)/s);
        if (!match) throw status(400, "invalid lol command");
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

        interface Match {
          game_stage: string;
          stime: number;
          etime: number;
          home_score: number;
          away_score: number;
          season: { title: string };
          home: { name: string };
          away: { name: string };
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
          return [
            `${match.season.title} ${match.game_stage}`,
            `${start} ~ ${end}`,
            `${match.home.name} ${match.home_score} - ${match.away_score} ${match.away.name}`,
          ].join("\n");
        };
        return matches.map(format).join("\n");
      }

      let name = "";
      // /[name]
      if (msg.startsWith("/")) {
        const match = msg.match(/\/(\S*)\s*(.*)/s);
        if (!match) throw status(400, "invalid / command");
        [, name, msg] = match;
      }
      const chain: string[] = [name];
      // /[name] -> ... -> /[provider/model]
      while (!chain.at(-1)?.includes("/") && chain.length < 42) {
        const value = await redis.get(`key:/${name}`);
        if (!value) {
          const keys = chain.map((v) => `/${v}`).join(" -> ");
          throw status(404, `key chain ${keys} not found`);
        }
        name = value;
        chain.push(name);
      }
      // chain
      if (msg === "chain") return chain.map((v) => `/${v}`).join(" -> ");

      const model = openrouter(chain.at(-1)!);
      const content: UserContent = [];
      if (image) {
        const url = URL.parse(image);
        if (url) content.push({ type: "image", image: url });
      }
      if (ref) content.push({ type: "text", text: ref });
      const messages: ModelMessage[] = [{ role: "user", content }];

      const tags = [];
      // #<tags>
      if (msg.startsWith("#")) {
        const match = msg.match(/#(\S+)\s*(.*)/s);
        if (!match) throw status(400, "invalid # command");
        [, , msg] = match;
        tags.push(...match[1].split("#"));
      }
      // tags
      if (msg === "tags") return tags.join(", ");

      // help
      if (msg === "help") {
        msg = "";
        tags.push("help");

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
        tags.push("credits");

        const response = await fetch("https://openrouter.ai/api/v1/credits", {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          },
        });
        const text = await response.text();
        content.push({ type: "text", text });
      }
      // hacker news [prompt]
      else if (msg.startsWith("hacker news")) {
        const match = msg.match(/hacker news\s*(.*)/s);
        if (!match) throw status(400, "invalid hacker news command");
        [, msg] = match;
        tags.push("hacker-news");

        const response = await fetch("https://news.ycombinator.com");
        const text = await response.text();
        content.push({ type: "text", text });
      }
      // tldr [url]
      else if (msg.startsWith("tldr")) {
        const match = msg.match(/tldr\s*(\S+)/s);
        if (!match) throw status(400, "invalid tldr command");
        [, msg] = match;
        tags.push("tldr");

        const response = await fetch(msg);
        const text = await response.text();
        content.push({ type: "text", text });
      }

      for (const tag of tags) {
        const value = await redis.get(`key:#${tag}`);
        if (!value) throw status(404, `key #${tag} not found`);
        messages.unshift({ role: "system", content: value });
      }

      // system
      // user [image, ref, msg]
      if (msg.length > 0) messages.push({ role: "user", content: msg });
      const { text } = await generateText({ model, messages });
      return text;
    },
    {
      body: t.Object({
        qq: t.Optional(t.String()),
        msg: t.String(),
        ref: t.Optional(t.String()),
        image: t.Optional(t.String()),
      }),
    }
  )
  .post("/api/v1/chat/completions", async ({ request }) => {
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
  .listen(3000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
