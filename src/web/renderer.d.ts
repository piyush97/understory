import type { Child } from "hono/jsx";

declare module "hono" {
  interface ContextRenderer {
    (content: Child): Response | Promise<Response>;
  }
}
