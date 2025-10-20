import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ============== CONFIG ==============
const {
  YAMPI_BASE_URL = "https://api.yampi.com.br",
  YAMPI_ALIAS = "sonhosdeninar",
  YAMPI_USER_TOKEN = "IsvW5rTgbJYCsi60MbeOYB5txTomDiRmBqJozw6d",
  YAMPI_SECRET_KEY = "sk_r6WnGTeQYkLwhJuR1rdLmjkbvZB34UjI6xLxV",
} = process.env;

// Evita crash se ALLOWED_ORIGINS não existir
const RAW_ORIGINS = (ALLOWED_ORIGINS ?? "").trim();
const LIST_ORIGINS = RAW_ORIGINS
  ? RAW_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

// Loga variáveis ausentes (apenas aviso; não derruba o app)
["YAMPI_BASE_URL", "YAMPI_ALIAS", "YAMPI_USER_TOKEN", "YAMPI_SECRET_KEY"].forEach(
  (k) => {
    if (!process.env[k]) console.error(`[ENV] Faltando ${k}`);
  }
);

// ============== HELPERS ==============
function centsToBRL(cents) {
  if (typeof cents !== "number") return "";
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
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "User-Token": YAMPI_USER_TOKEN,
    "User-Secret-Key": YAMPI_SECRET_KEY,
  };
}

// ============== CORS ==============
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  let allow = false;

  // 1) se estiver explicitamente na lista
  if (origin && LIST_ORIGINS.some((o) => o === origin)) allow = true;

  // 2) senão, allowlist padrão (se quiser, pode remover)
  if (!allow && origin) {
    try {
      const host = new URL(origin).hostname;
      if (/(^|\.)myshopify\.com$/i.test(host)) allow = true;
      if (/sonhosdeninar\.com$/i.test(host)) allow = true; // ajuste seu domínio
    } catch {
      /* ignore URL parse errors */
    }
  }

  if (allow) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ============== YAMPI V2 ==============

// Cotação de frete v2
async function yampiQuoteV2({ zipcode, skusIds }) {
  const url = `${YAMPI_BASE_URL}/v2/${YAMPI_ALIAS}/logistics/shipping-costs`;
  const body = { zipcode: normZip(zipcode), origin: "cart", skus_ids: skusIds };

  const resp = await fetch(url, {
    method: "POST",
    headers: yampiHeaders(),
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`QUOTE_${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  const list = Array.isArray(data?.data)
    ? data.data
    : data?.data
    ? [data.data]
    : [];
  return list;
}

// Produtos v2 por IDs numéricos — pegar posting/lead time
async function yampiProductsBySkusV2(skusIds) {
  if (!skusIds.length) return {};
  const unique = [...new Set(skusIds)];
  const url = `${YAMPI_BASE_URL}/v2/${YAMPI_ALIAS}/products?skus_ids=${encodeURIComponent(
    unique.join(",")
  )}`;

  const resp = await fetch(url, { headers: yampiHeaders() });
  if (!resp.ok) throw new Error(`PROD_IDS_${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  const arr = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data)
    ? data
    : [];
  const map = {};
  for (const p of arr) {
    const id = Number(p?.id ?? p?.sku_id ?? p?.sku ?? p?.code);
    const days = Number(
      p?.posting_days ??
        p?.lead_time ??
        p?.production_time_days ??
        p?.handling_time ??
        0
    );
    if (!Number.isNaN(id)) map[id] = Math.max(0, days);
  }
  return map; // { skuId: postingDays }
}

// Resolve sku_id a partir de SKU string (fallback)
const SKU_CACHE = new Map(); // skuString -> { id, ts }
const SKU_CACHE_TTL_MS = 10 * 60 * 1000;

function cacheGetSkuId(sku) {
  const hit = SKU_CACHE.get(sku);
  if (!hit) return null;
  if (Date.now() - hit.ts > SKU_CACHE_TTL_MS) {
    SKU_CACHE.delete(sku);
    return null;
  }
  return hit.id;
}
function cacheSetSkuId(sku, id) {
  SKU_CACHE.set(sku, { id, ts: Date.now() });
}

async function yampiProductsBySkuCodes(skuCodes = []) {
  if (!skuCodes.length) return {};
  const unique = [...new Set(skuCodes)];
  const base = `${YAMPI_BASE_URL}/v2/${YAMPI_ALIAS}/products`;

  const toMap = (json) => {
    const arr = Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json)
      ? json
      : [];
    const map = {};
    for (const p of arr) {
      const skuStr = String(p?.sku || p?.code || "").trim();
      const idNum = Number(p?.id ?? p?.sku_id);
      if (skuStr && Number.isFinite(idNum)) {
        map[skuStr] = idNum;
      }
    }
    return map;
  };

  // tenta ?skus=
  let url = `${base}?skus=${encodeURIComponent(unique.join(","))}`;
  let resp = await fetch(url, { headers: yampiHeaders() });

  // senão, ?sku_codes=
  if (!resp.ok) {
    url = `${base}?sku_codes=${encodeURIComponent(unique.join(","))}`;
    resp = await fetch(url, { headers: yampiHeaders() });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `PROD_SKUS_LOOKUP_${resp.status}: ${
          body || "Falha ao buscar produtos por SKU"
        }`
      );
    }
  }

  const data = await resp.json();
  const map = toMap(data);
  for (const [sku, id] of Object.entries(map)) cacheSetSkuId(sku, id);
  return map;
}

// ============== ROTAS ==============
app.get("/", (_req, res) => {
  res
    .type("html")
    .send("<h1>Frete Carrinho Yampi Proxy</h1><p>App instalado.</p>");
});

app.get("/healthz", (_req, res) => res.send("ok"));
app.get("/proxy", (_req, res) => res.json({ message: "Proxy ativo!" }));

app.post("/proxy", async (req, res) => {
  try {
    const { postal_code, items = [] } = req.body || {};
    if (!postal_code || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "payload inválido" });
    }

    // 1) Monta lista de skus_ids
    const skusIds = [];

    // sku_id_yampi numérico
    for (const it of items) {
      const id = Number(it.sku_id_yampi ?? it.sku_id);
      const qty = Number(it.quantity || 1);
      if (Number.isFinite(id)) {
        for (let i = 0; i < qty; i++) skusIds.push(id);
      }
    }

    // Fallback por SKU string
    if (!skusIds.length) {
      const skuCodes = [];
      for (const it of items) {
        const skuStr = String(it.sku ?? "").trim();
        if (skuStr) skuCodes.push(skuStr);
      }
      if (!skuCodes.length) {
        return res.status(400).json({
          error:
            "nenhum SKU informado; envie 'sku' (string) ou 'sku_id_yampi' numérico",
        });
      }

      const skuIdMap = {};
      const missing = [];
      for (const sku of skuCodes) {
        const cached = cacheGetSkuId(sku);
        if (cached != null) skuIdMap[sku] = cached;
        else missing.push(sku);
      }

      if (missing.length) {
        const fetched = await yampiProductsBySkuCodes(missing);
        Object.assign(skuIdMap, fetched);
      }

      const notFound = skuCodes.filter((s) => skuIdMap[s] == null);
      if (notFound.length) {
        return res.status(422).json({
          error: "sku_nao_encontrado_na_yampi",
          detail: `SKUs não encontrados: ${notFound.join(", ")}`,
        });
      }

      for (const it of items) {
        const skuStr = String(it.sku ?? "").trim();
        const id = skuIdMap[skuStr];
        const qty = Number(it.quantity || 1);
        for (let i = 0; i < qty; i++) skusIds.push(id);
      }
    }

    if (!skusIds.length) {
      return res.status(400).json({
        error:
          "skus_ids ausentes; envie sku_id_yampi numérico por item ou sku string para resolver",
      });
    }

    // 2) Cotação
    const services = await yampiQuoteV2({ zipcode: postal_code, skusIds });

    // 3) Tempo de postagem (maior entre os itens)
    const postingBySkuId = await yampiProductsBySkusV2(skusIds);
    const postingMax = Object.values(postingBySkuId).reduce(
      (a, b) => Math.max(a, Number(b || 0)),
      0
    );

    // 4) Normaliza
    const rates = services.map((s) => {
      const priceCents =
        typeof s.price === "number"
          ? s.price
          : typeof s.amount === "number"
          ? s.amount
          : null;

      const baseDays = Number(
        s.delivery_time ?? s.deadline ?? s.estimated_days ?? 0
      );
      const totalDays = baseDays + postingMax;

      return {
        name: s.service_display_name || s.service_name || s.title,
        code: s.service_id || s.service_code,
        price: priceCents ?? s.price,
        formatted_price:
          priceCents != null
            ? centsToBRL(priceCents)
            : s.formatted_price || s.price,
        deadline: totalDays
          ? `até ${totalDays} dia${totalDays > 1 ? "s" : ""}`
          : "",
      };
    });

    res.set("Cache-Control", "no-store");
    return res.json({ rates });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ error: "falha no proxy", detail: String(e?.message || e) });
  }
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("listening on", PORT));
