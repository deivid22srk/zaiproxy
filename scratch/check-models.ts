import { createContainer } from "../src/bootstrap/container.js";

async function main() {
  const container = createContainer();
  const account = container.accounts.list()[0];
  if (!account) {
    console.error("No account found in DB");
    return;
  }

  console.log("Account found:", account.email);
  console.log("Token preview:", account.token.slice(0, 50) + "...");

  const url = "https://chat.z.ai/api/models";
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${account.token}`);
  headers.set("Content-Type", "application/json");
  headers.set("Origin", "https://chat.z.ai");
  headers.set("Referer", "https://chat.z.ai/");
  headers.set("User-Agent", account.userAgent);
  headers.set("X-FE-Version", "prod-fe-1.1.39");
  headers.set("X-Region", "overseas");
  
  if (account.cookies) {
    const cookieHeader = account.cookies
      .map((c: any) => `${c.name}=${c.value}`)
      .join("; ");
    headers.set("Cookie", cookieHeader);
  }

  console.log("Querying models...");
  const res = await fetch(url, { headers });
  console.log("Response status:", res.status, res.statusText);
  const json = await res.json() as { data: Array<{ id: string }> };
  console.log("Models list:", json.data.map(m => m.id));
}

main().catch(console.error);
