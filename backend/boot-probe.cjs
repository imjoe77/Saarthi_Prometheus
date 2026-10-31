// Boots the compiled backend on a spare port so we can read the real error.
process.env.PORT = process.env.PROBE_PORT ?? "3011";

const { NestFactory } = require("@nestjs/core");
const { AppModule } = require("./dist/app.module");

(async () => {
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn", "log"] });
  const prefix = process.env.API_PREFIX ?? "api";
  app.setGlobalPrefix(prefix);
  await app.listen(process.env.PORT, "127.0.0.1");

  const token = process.env.TOKEN;
  const base = `http://127.0.0.1:${process.env.PORT}`;
  const paths = [
    "/api/market-data/instruments",
    "/api/market-data/status",
    "/api/market-data/quotes?symbol=AAPL",
    "/api/market-data/bars?symbol=AAPL&timeframe=1m&limit=5",
  ];
  for (const p of paths) {
    const r = await fetch(base + p, { headers: { authorization: `Bearer ${token}` } });
    const t = await r.text();
    console.log(`>>> ${p} -> ${r.status}`);
    console.log(t.slice(0, 400));
  }
  await app.close();
  process.exit(0);
})().catch((e) => {
  console.error("BOOT FAILED", e);
  process.exit(1);
});
