#!/usr/bin/env node
// Manage /admin logins on the BAINK host (docs/admin.md). Run as the BAINK service user:
//   BAINK_DATA_DIR=/var/lib/baink node ops/admin-user.mjs add aldi@example.com   # asks for the password
//   BAINK_DATA_DIR=/var/lib/baink node ops/admin-user.mjs reset aldi@example.com
//   BAINK_DATA_DIR=/var/lib/baink node ops/admin-user.mjs remove aldi@example.com
//   BAINK_DATA_DIR=/var/lib/baink node ops/admin-user.mjs list
//   BAINK_DATA_DIR=/var/lib/baink node ops/admin-user.mjs token-add drafts [--scope drafts:create,replies:create]   # prints the token once
//   BAINK_DATA_DIR=/var/lib/baink node ops/admin-user.mjs token-scope drafts drafts:create,replies:create,marketing:read   # change scopes, same token
//   BAINK_DATA_DIR=/var/lib/baink node ops/admin-user.mjs token-remove drafts
// The password is read from the terminal without echo, or from ADMIN_PASSWORD for scripts.
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { hashPassword, normalEmail, readUsers, writeUsers, readTokens, writeTokens, tokenDigest, TOKEN_SCOPES } from "../server/admin.mjs";

const dataDir = process.env.BAINK_DATA_DIR;
if (!dataDir) { console.error("Set BAINK_DATA_DIR to the BAINK data directory."); process.exit(2); }
const args = process.argv.slice(2);
const scopeFlag = args.indexOf("--scope");
const scopeArg = scopeFlag >= 0 ? args.splice(scopeFlag, 2)[1] : undefined;
const [command, rawEmail, extraArg] = args;
function parseScopes(value) {
  const list = String(value ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (!list.length || list.some((v) => !TOKEN_SCOPES.includes(v))) throw new Error(`Scopes are a comma list of: ${TOKEN_SCOPES.join(", ")}.`);
  return [...new Set(list)].join(",");
}

function askPassword(prompt) {
  if (process.env.ADMIN_PASSWORD) return Promise.resolve(process.env.ADMIN_PASSWORD);
  if (!process.stdin.isTTY) { console.error("No terminal: set ADMIN_PASSWORD."); process.exit(2); }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) rl.output.write(s); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

try {
  const users = await readUsers(dataDir);
  if (command === "list") {
    for (const [email, u] of Object.entries(users)) console.log(`${email}\tcreated ${u.createdAt}${u.updatedAt ? `\tpassword changed ${u.updatedAt}` : ""}`);
    if (!Object.keys(users).length) console.log("No admin users.");
    for (const [name, t] of Object.entries(await readTokens(dataDir))) console.log(`token ${name}\t${t.scope}\tcreated ${t.createdAt}`);
  } else if (command === "token-scope") {
    const name = String(rawEmail ?? "");
    const tokens = await readTokens(dataDir);
    if (!tokens[name]) throw new Error(`No token named ${name}.`);
    tokens[name] = { ...tokens[name], scope: parseScopes(extraArg ?? scopeArg), updatedAt: new Date().toISOString() };
    await writeTokens(dataDir, tokens);
    console.log(`token ${name} scopes: ${tokens[name].scope} (token value unchanged).`);
  } else if (command === "token-add" || command === "token-remove") {
    const name = String(rawEmail ?? "");
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) throw new Error("Give a short lowercase token name, e.g. drafts.");
    const tokens = await readTokens(dataDir);
    if (command === "token-remove") {
      if (!tokens[name]) throw new Error(`No token named ${name}.`);
      delete tokens[name]; await writeTokens(dataDir, tokens); console.log(`token ${name} removed.`);
    } else {
      if (tokens[name]) throw new Error(`Token ${name} exists; remove it first.`);
      const token = randomBytes(32).toString("base64url");
      const scope = scopeArg ? parseScopes(scopeArg) : "drafts:create";
      tokens[name] = { hash: tokenDigest(token), scope, createdAt: new Date().toISOString() };
      await writeTokens(dataDir, tokens);
      console.log(`Token ${name} (${scope}; nothing else). Shown once:\n${token}`);
    }
  } else if (["add", "reset", "remove"].includes(command)) {
    const email = normalEmail(rawEmail);
    if (command === "add" && users[email]) throw new Error(`${email} already exists; use reset.`);
    if (command !== "add" && !users[email]) throw new Error(`${email} does not exist.`);
    if (command === "remove") delete users[email];
    else {
      const password = await askPassword(`Password for ${email} (12+ characters): `);
      const at = new Date().toISOString();
      users[email] = command === "add" ? { password: await hashPassword(password), createdAt: at } : { ...users[email], password: await hashPassword(password), updatedAt: at };
    }
    await writeUsers(dataDir, users);
    console.log(`${command} ${email}: done. Live sessions of a removed user end within 10 seconds; a reset does not end them (restart BAINK to force).`);
  } else {
    console.error("Usage: admin-user.mjs add|reset|remove <email> | list | token-add <name> [--scope a,b] | token-scope <name> <a,b> | token-remove <name>"); process.exit(2);
  }
} catch (error) { console.error(error.message); process.exit(1); }
