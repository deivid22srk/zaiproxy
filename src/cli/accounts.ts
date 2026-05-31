import { createContainer } from "../bootstrap/container.js";
import { isGuestEmail } from "../services/account-pool.js";

const container = createContainer();
const accounts = container.accounts.list();

if (accounts.length === 0) {
  console.log("No accounts saved.");
  process.exit(0);
}

for (const account of accounts) {
  const kind = isGuestEmail(account.email) ? "guest" : "real";
  const usable =
    account.status === "active" && kind === "real" && (!account.limitedUntil || account.limitedUntil <= new Date().toISOString());
  console.log(
    [
      `id=${account.id}`,
      `email=${account.email}`,
      `kind=${kind}`,
      `status=${account.status}`,
      `usable=${usable}`,
      `failures=${account.failureCount}`,
      `limited_until=${account.limitedUntil ?? "-"}`,
      `last_error=${account.lastError ?? "-"}`,
      `profile=${account.browserProfilePath}`
    ].join(" ")
  );
}
