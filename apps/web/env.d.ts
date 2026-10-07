// Minimal binding types (full @cloudflare/workers-types clash with the DOM lib).
declare module "cloudflare:workers" {
  export const env: { API?: { fetch(input: string, init?: RequestInit): Promise<Response> } };
}
