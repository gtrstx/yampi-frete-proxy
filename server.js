import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ======================
// Utils / Config
// ======================
function centsToBRL(cents) {
  return `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;
}

function yampiHeaders() {
  return {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "User-Token": process.env.YAMPI_USER_TOKEN,
    "User-Secret-Key": process.env.YAMPI_SECRET_KEY
  };
}


function normZip(zip) {
  return String(zip || "").replace(/\D/g, "");
}

// ======================
// Chamadas Yampi v2
// ======================

// Cotação de frete v2
async function yampiQuoteV2({ zipcode, skusIds }) {
  const url = `${process.env.YAMPI_BASE_URL}/v2/${process.env.YAMPI_ALIAS}/logistics/shipping-costs`;
  const body = {
    zipcode: normZip(zipcode),
    origin: "cart",
    skus_ids: skusIds, // repetir cada ID conforme quantity
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: yampiHeaders(),
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`QUOTE_${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  const list = Array.isArray(data?.data) ? data.data : data?.data ? [data.data] : [];
  return list; // array de serviços
}

// Produtos v2 (por IDs numéricos) — para obter tempo de postagem
async function yampiProductsBySkusV2(skusIds) {
  if (!skusIds.length) return {};
  const unique = [...new Set(skusIds)];
  const url = `${process.env.YAMPI_BASE_URL}/v2/${process.env.YAMPI_ALIAS}/products?skus_ids=${encodeURIComponent(
    unique.join(",")
  )}`;

  const resp = await fetch(url, { headers: yampiHeaders() });
  if (!resp.ok) throw new Error(`PROD_IDS_${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  const arr = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
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

// ======================
// Resolver sku_id a partir de SKU string (com fallback)
// ======================
const SKU_CACHE = new Map(); // skuString -> { id, ts }
const SKU_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos

function cacheGetSkuId(sku) {
  const hit = SKU_CACHE.get(sku);
  if (!hit) return null;
  if (Date.now() - hit.ts > SKU_CACHE_TTL_MS) { SKU_CACHE.delete(sku); return null; }
  return hit.id;
}
function cacheSetSkuId(sku, id) {
  SKU_CACHE.set(sku, { id, ts: Date.now() });
}

// Busca produtos por **SKU string** para pegar IDs numéricos (sku_id)
// Tenta ?skus= e, se falhar, tenta ?sku_codes=
async function yampiProductsBySkuCodes(skuCodes = []) {
  if (!skuCodes.length) return {};
  const unique = [...new Set(skuCodes)];
  const base = `${process.env.YAMPI_BASE_URL}/v2/${process.env.YAMPI_ALIAS}/products`;

  const toMap = (json) => {
    const arr = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);
    const map = {};
    for (const p of arr) {
      const skuStr = String(p?.sku || p?.code || "").trim();
      const idNum  = Number(p?.id ?? p?.sku_id);
      if (skuStr && Number.isFinite(idNum)) {
        map[skuStr] = idNum;
      }
    }
    return map;
  };

  // 1) tenta ?skus=
  let url = `${base}?skus=${encodeURIComponent(unique.join(","))}`;
  let resp = await fetch(url, { headers: yampiHeaders() });

  // 2) se não OK, tenta ?sku_codes=
  if (!resp.ok) {
    url = `${base}?sku_codes=${encodeURIComponent(unique.join(","))}`;
    resp = await fetch(url, { headers: yampiHeaders() });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`PROD_SKUS_LOOKUP_${resp.status}: ${body || "Falha ao buscar produtos por SKU"}`);
    }
  }

  const data = await resp.json();
  const map = toMap(data);

  // cache simples
  for (const [sku, id] of Object.entries(map)) {
    cacheSetSkuId(sku, id);
  }
  return map; // { "SKU-ABC": 1233, ... }
}

// ======================
// Rotas
// ======================

// Healthcheck / página de instalação
app.get("/", (_req, res) => {
  res.type("html").send(`
    <h1>Frete Carrinho Yampi Proxy</h1>
    <p>App instalado com sucesso.</p>
  `);
});

// Teste rápido (GET) - App Proxy
app.get("/proxy", (_req, res) => {
  res.json({ message: "Proxy ativo!" });
});

// Cálculo REAL via Yampi (POST)
app.post("/proxy", async (req, res) => {
  try {
    const { postal_code, items = [] } = req.body || {};
    if (!postal_code || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "payload inválido" });
    }

    // ======================
    // 1) Resolver skus_ids
    // ======================
    const skusIds = [];

    // Primeiro: tenta usar sku_id_yampi numérico (melhor cenário)
    for (const it of items) {
      const id = Number(it.sku_id_yampi ?? it.sku_id);
      const qty = Number(it.quantity || 1);
      if (Number.isFinite(id)) {
        for (let i = 0; i < qty; i++) skusIds.push(id);
      }
    }

    // Se nenhum ID foi encontrado, tentar resolver por SKU string
    if (!skusIds.length) {
      const skuCodes = [];
      for (const it of items) {
        const skuStr = String(it.sku ?? "").trim();
        if (skuStr) skuCodes.push(skuStr);
      }
      if (!skuCodes.length) {
        return res.status(400).json({
          error: "nenhum SKU informado; envie 'sku' (string) ou 'sku_id_yampi' numérico"
        });
      }

      // cache -> API
      const skuIdMap = {};
      const missing = [];
      for (const sku of skuCodes) {
        const cached = cacheGetSkuId(sku);
        if (cached != null) skuIdMap[sku] = cached; else missing.push(sku);
      }

      if (missing.length) {
        const fetched = await yampiProductsBySkuCodes(missing);
        Object.assign(skuIdMap, fetched);
      }

      const notFound = skuCodes.filter(s => skuIdMap[s] == null);
      if (notFound.length) {
        return res.status(422).json({
          error: "sku_nao_encontrado_na_yampi",
          detail: `SKUs não encontrados na Yampi: ${notFound.join(", ")}`
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
        error: "skus_ids ausentes; envie sku_id_yampi numérico por item ou sku string para resolver"
      });
    }

    // ======================
    // 2) Cotar na Yampi
    // ======================
    const services = await yampiQuoteV2({ zipcode: postal_code, skusIds });

    // ======================
    // 3) Tempo de postagem (MAIOR entre os itens)
    // ======================
    const postingBySkuId = await yampiProductsBySkusV2(skusIds);
    const postingMax = Object.values(postingBySkuId).reduce(
      (a, b) => Math.max(a, Number(b || 0)),
      0
    );

    // ======================
    // 4) Normalizar resposta (paridade com checkout)
    // ======================
    const rates = services.map((s) => {
      const priceCents =
        typeof s.price === "number"
          ? s.price
          : typeof s.amount === "number"
          ? s.amount
          : null;

      const baseDays = Number(s.delivery_time ?? s.deadline ?? s.estimated_days ?? 0);
      const totalDays = baseDays + postingMax;

      return {
        name: s.service_display_name || s.service_name || s.title,
        code: s.service_id || s.service_code,
        price: priceCents ?? s.price,
        formatted_price:
          priceCents != null ? centsToBRL(priceCents) : (s.formatted_price || s.price),
        deadline: totalDays ? `até ${totalDays} dia${totalDays > 1 ? "s" : ""}` : "",
      };
    });

    res.set("Cache-Control", "no-store");
    return res.json({ rates });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      error: "falha no proxy",
      detail: String(e?.message || e)
    });
  }
});

// Porta (Render define PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy ON na porta ${PORT}`));
