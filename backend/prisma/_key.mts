import { readFileSync } from "node:fs";
for (const f of ["D:/SEM 5/Mini Project/prometheus/.env.local", "D:/SEM 5/Mini Project/prometheus/.env"]) {
  try {
    const t = readFileSync(f, "utf8");
    const m = t.match(/^AUTH_API_SIGNING_PRIVATE_KEY=(.*)$/m);
    if (!m) { console.log(f + ": key absent"); continue; }
    const raw = m[1];
    console.log(f + ": rawLen=" + raw.length + " head=" + JSON.stringify(raw.slice(0, 45)) + " tail=" + JSON.stringify(raw.slice(-45)));
    const un = raw.replace(/\\n/g, "\n").replace(/^["']|["']$/g, "");
    console.log("  unescaped head=" + JSON.stringify(un.slice(0, 45)) + " tail=" + JSON.stringify(un.slice(-45)) + " len=" + un.length);
  } catch (e) { console.log(f + ": " + e.message); }
}
