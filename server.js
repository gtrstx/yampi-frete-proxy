// server.js
// Node 18+ (ESM). Start: `node server.js`

import express from "express";
import fetch from "node-fetch";

// ===============
// ENV & Defaults
// ===============
const ENV = {
  YAMPI_BASE_URL: process.env.YAMPI_BASE_URL || "https://api.yampi.com.br",
  YAMPI_ALIAS: process.env.YAMPI_ALIAS || "sonhosdeninar",
  YAMPI_USER_TOKEN: process.env.YAMPI_USER_TOKEN || "IsvW5rTgbJYCsi60MbeOYB5txTomDiRmBqJozw6d",
  YAMPI_SECRET_KEY: process.env.YAMPI_SECRET_KEY || "sk_r6WnGTeQYkLwhJuR1rdLmjkbvZB34UjI6xLxV",
  NODE_ENV: process.env.NODE_ENV || "production",
};

["YAMPI_BASE_URL", "YAMPI_ALIAS", "YAMPI_USER_TOKEN", "YAMPI_SECRET_KEY"].forEach((k) => {
  if (!ENV[k]) console.error(`[ENV] Faltando ${k}`);
});

const app = express();
app.set("trust proxy", true);

// Body parsers (JSON + urlencoded para compatibilidade)
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ======= CORS (flexível, mas seguro) =======
const ORIGIN_RE = /(sonhosdeninar\.com|myshopify\.com)$/i;
const allowlist = new Set(
  ENV.ALLOWED_ORIGINS
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const allowed = ORIGIN_RE.test(origin) || allowlist.has(origin);

  if (allowed) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ===== Utilidades =====
function centsToBRL(cents) {
  if (typeof cents !== "number" || Number.isNaN(cents)) return "";
  return `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;
}
function normZip(zip) {
  return String(zip || "").replace(/\D/g, "");
}
function yampiHeaders() {
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "User-Token": ENV.YAMPI_USER_TOKEN,
    "User-Secret-Key": ENV.YAMPI_SECRET_KEY,
  };
}

// ========= Cache simples para SKU string -> ID =========
const SKU_CACHE = new Map(); // skuString -> { id, ts }
const SKU_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos
const cacheGetSkuId = (sku) => {
  const hit = SKU_CACHE.get(sku);
  if (!hit) return null;
  if (Date.now() - hit.ts > SKU_CACHE_TTL_MS) {
    SKU_CACHE.delete(sku);
    return null;
  }
  return hit.id;
};
const cacheSetSkuId = (sku, id) => SKU_CACHE.set(sku, { id, ts: Date.now() });

// ========= Chamadas Yampi v2 =========
async function yFetch(url, opts = {}) {
  // timeout para evitar pendurar
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000); // 15s
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(t);
  }
}

// Cotação (v2)
async function yampiQuoteV2({ zipcode, skusIds }) {
  const url = `${ENV.YAMPI_BASE_URL}/v2/${ENV.YAMPI_ALIAS}/logistics/shipping-costs`;
  const body = {
    zipcode: normZip(zipcode),
    origin: "cart",
    skus_ids: skusIds, // repetir por quantity
  };

  const resp = await yFetch(url, {
    method: "POST",
    headers: yampiHeaders(),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const isCF = resp.status === 403 && /1020|Access Denied/i.test(text);
    const tag = isCF ? "YAMPI_CLOUDFLARE_403" : `QUOTE_${resp.status}`;
    throw new Error(`${tag}: ${text || "Falha ao cotar frete"}`);
  }

  const data = await resp.json();
  const list = Array.isArray(data?.data) ? data.data : data?.data ? [data.data] : [];
  return list; // array de serviços
}

// Produtos por IDs (v2) -> posting/lead time
async function yampiProductsBySkusV2(skusIds) {
  if (!skusIds.length) return {};
  const unique = [...new Set(skusIds)];
  const url = `${ENV.YAMPI_BASE_URL}/v2/${ENV.YAMPI_ALIAS}/products?skus_ids=${encodeURIComponent(
    unique.join(",")
  )}`;

  const resp = await yFetch(url, { headers: yampiHeaders() });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`PROD_IDS_${resp.status}: ${text || "Falha ao buscar produtos por ID"}`);
  }

  const json = await resp.json();
  const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  const map = {};
  for (const p of arr) {
    // vários nomes possíveis de campo em contas/versões diferentes
    const id = Number(p?.id ?? p?.sku_id ?? p?.sku ?? p?.code);
    const days = Number(
      p?.posting_days ?? p?.lead_time ?? p?.production_time_days ?? p?.handling_time ?? 0
    );
    if (Number.isFinite(id)) map[id] = Math.max(0, days);
  }
  return map; // { skuId: postingDays }
}

// Produtos por SKU (string) -> ID
async function yampiProductsBySkuCodes(skuCodes = []) {
  if (!skuCodes.length) return {};
  const unique = [...new Set(skuCodes)];
  const base = `${ENV.YAMPI_BASE_URL}/v2/${ENV.YAMPI_ALIAS}/products`;

  const toMap = (json) => {
    const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    const map = {};
    for (const p of arr) {
      const skuStr = String(p?.sku || p?.code || "").trim();
      const idNum = Number(p?.id ?? p?.sku_id);
      if (skuStr && Number.isFinite(idNum)) map[skuStr] = idNum;
    }
    return map;
  };

  // 1) tenta ?skus=
  let url = `${base}?skus=${encodeURIComponent(unique.join(","))}`;
  let resp = await yFetch(url, { headers: yampiHeaders() });

  // 2) fallback ?sku_codes=
  if (!resp.ok) {
    url = `${base}?sku_codes=${encodeURIComponent(unique.join(","))}`;
    resp = await yFetch(url, { headers: yampiHeaders() });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const isCF = resp.status === 403 && /1020|Access Denied/i.test(body);
      const tag = isCF ? "PROD_SKUS_LOOKUP_CLOUDFLARE_403" : `PROD_SKUS_LOOKUP_${resp.status}`;
      throw new Error(`${tag}: ${body || "Falha ao buscar produtos por SKU"}`);
    }
  }

  const data = await resp.json();
  const map = toMap(data);

  // cache
  for (const [sku, id] of Object.entries(map)) cacheSetSkuId(sku, id);
  return map; // { "ABC-123": 999, ... }
}

// ====== Normalização de entrada ======
/**
 * Aceita payloads nos formatos:
 * A) { postal_code, items: [{ sku_id_yampi, quantity } | { sku, quantity }] }
 * B) { zipcode, items: [{ sku_id_yampi, quantity } | { sku, quantity }] }
 * C) { postal_code, cart_items: [itens do /cart.js Shopify, com properties.yampi_sku_id] }
 */
function parseInput(body) {
  const postal = body?.postal_code || body?.zipcode || body?.zip || body?.cep;
  let items = Array.isArray(body?.items) ? body.items : [];

  // Suporta cart.js bruto
  if (!items.length && Array.isArray(body?.cart_items)) {
    items = body.cart_items.map((ci) => {
      const skuId = Number(ci?.properties?.yampi_sku_id ?? ci?.properties?.YAMPI_SKU_ID);
      return {
        sku_id_yampi: Number.isFinite(skuId) ? skuId : undefined,
        sku: ci?.sku || ci?.variant_sku || ci?.product?.sku || "",
        quantity: Number(ci?.quantity || 1),
      };
    });
  }

  return { postal_code: postal ? normZip(postal) : "", items };
}

// ====== Normalização de serviços ======
function normalizeRates(services, postingMax) {
  return services.map((s) => {
    const priceCents =
      typeof s.price === "number" ? s.price : typeof s.amount === "number" ? s.amount : null;

    const baseDays = Number(s.delivery_time ?? s.deadline ?? s.estimated_days ?? 0);
    const totalDays = Math.max(0, baseDays) + Math.max(0, Number(postingMax || 0));

    return {
      name: s.service_display_name || s.service_name || s.title || "Envio",
      code: s.service_id || s.service_code || s.id || "",
      price: priceCents ?? s.price ?? null,
      formatted_price: priceCents != null ? centsToBRL(priceCents) : s.formatted_price || "",
      deadline: totalDays ? `até ${totalDays} dia${totalDays > 1 ? "s" : ""}` : "",
    };
  });
}

// ====== Rotas ======

// página simples para sanity check
app.get("/", (_req, res) => {
  res.type("html").send(`
    <h1>Yampi Shipping Proxy</h1>
    <p>Status: OK</p>
    <ul>
      <li>GET <code>/healthz</code></li>
      <li>GET <code>/proxy</code> (ping)</li>
      <li>POST <code>/proxy</code> (cotação)</li>
    </ul>
  `);
});

app.get("/healthz", (_req, res) => res.send("ok"));

app.get("/proxy", (req, res) => {
  res.json({ ok: true, message: "Proxy ativo!", ts: new Date().toISOString() });
});

// Rota principal (App Proxy aponta aqui)
app.post("/proxy", async (req, res) => {
  const started = Date.now();
  try {
    const input = parseInput(req.body || {});
    const { postal_code, items } = input;

    if (!postal_code) {
      return res.status(400).json({ error: "postal_code_ausente", detail: "Informe CEP" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "itens_ausentes", detail: "Envie items[]" });
    }

    // 1) Construir lista de IDs (repetindo por quantity)
    const skusIds = [];

    // 1a) preferir sku_id_yampi
    for (const it of items) {
      const qty = Math.max(1, Number(it.quantity || 1));
      const id = Number(it.sku_id_yampi ?? it.sku_id);
      if (Number.isFinite(id)) for (let i = 0; i < qty; i++) skusIds.push(id);
    }

    // 1b) fallback por SKU string
    if (!skusIds.length) {
      const skuCodes = items
        .map((it) => String(it.sku || "").trim())
        .filter(Boolean);

      if (!skuCodes.length) {
        return res.status(400).json({
          error: "nenhum_sku_informado",
          detail: "Envie 'sku_id_yampi' numérico ou 'sku' string em cada item.",
        });
      }

      // cache -> fetch
      const map = {};
      const missing = [];
      for (const sku of skuCodes) {
        const cached = cacheGetSkuId(sku);
        if (cached != null) map[sku] = cached;
        else missing.push(sku);
      }
      if (missing.length) {
        const fetched = await yampiProductsBySkuCodes(missing);
        Object.assign(map, fetched);
      }

      const notFound = skuCodes.filter((s) => map[s] == null);
      if (notFound.length) {
        return res.status(422).json({
          error: "sku_nao_encontrado_na_yampi",
          detail: `SKUs não encontrados: ${notFound.join(", ")}`,
        });
      }

      for (const it of items) {
        const qty = Math.max(1, Number(it.quantity || 1));
        const id = map[String(it.sku).trim()];
        for (let i = 0; i < qty; i++) skusIds.push(id);
      }
    }

    if (!skusIds.length) {
      return res.status(400).json({
        error: "skus_ids_ausentes",
        detail: "Não foi possível resolver IDs a partir dos itens enviados.",
      });
    }

    // 2) Cotar na Yampi
    const services = await yampiQuoteV2({ zipcode: postal_code, skusIds });

    // 3) Posting days (pega o MAIOR entre os itens do carrinho)
    const postingBySkuId = await yampiProductsBySkusV2(skusIds);
    const postingMax = Object.values(postingBySkuId).reduce(
      (a, b) => Math.max(a, Number(b || 0)),
      0
    );

    // 4) Normalizar resposta
    const rates = normalizeRates(services, postingMax);

    res.set("Cache-Control", "no-store");
    return res.json({ rates, meta: { posting_max_days: postingMax, took_ms: Date.now() - started } });
  } catch (err) {
    const msg = String(err?.message || err || "");
    console.error("[/proxy] erro:", msg);

    // Erros frequentes tratados com códigos legíveis
    if (/CLOUDFLARE_403/i.test(msg)) {
      return res.status(502).json({
        error: "yampi_cloudflare_block",
        detail:
          "A Yampi bloqueou a chamada (Cloudflare 1020/403). Solicite whitelist do IP do servidor ou use infraestrutura localizada no BR.",
      });
    }
    if (/QUOTE_\d+|PROD_IDS_\d+|PROD_SKUS_LOOKUP_\d+/i.test(msg)) {
      return res.status(502).json({
        error: "yampi_api_error",
        detail: msg,
      });
    }

    return res.status(500).json({ error: "falha_no_proxy", detail: msg });
  }
});

// ====== Start ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[startup] listening on ${PORT} (${ENV.NODE_ENV})`);
});
