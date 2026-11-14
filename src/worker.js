// Workers 入口：/api/* 交给 Pages Functions 风格的处理函数，其余走静态资源。
// 这样同一份 functions/api/[[path]].js 既能用于 `wrangler pages dev`，也能部署为 Worker（自定义域名自动建 DNS）。
import { onRequest } from "../functions/api/[[path]].js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const rest = url.pathname.replace(/^\/api\/?/, "");
      return onRequest({
        request,
        env,
        params: { path: rest ? rest.split("/") : [] },
        waitUntil: (p) => ctx.waitUntil(p),
        passThroughOnException: () => {},
        next: () => env.ASSETS.fetch(request),
        data: {},
      });
    }
    return env.ASSETS.fetch(request);
  },
};
