import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ======================
// Utils
// ======================
function centsToBRL(cents) {
  return `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;
}

function yampiHeaders() {
  return {
    "Content-Type": "application/json",
    "User-Token": process.env.YAMPI_USER_TOKEN,
    "User-Secret-Key": process.env.YAMPI_SECRET_KEY,
  };
}

// Cotação de frete v2
async function yampiQuoteV2({ zipcode, skusIds }) {
  const url = `${process.env.YAMPI_BASE_URL}/v2/${process.env.YAMPI_ALIAS}/logistics/shipping-costs`;
  const body = {
    zipcode: String(zipcode).replace(/\D/g, ""),
    origin: "cart",
    skus_ids: skusIds, // repita o ID conforme quantity!
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: yampiHeaders(),
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`QUOTE_${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  // normaliza: pode vir data: {...} ou data: [...]
  const list = Array.isArray(data?.data) ? data.data : data?.data ? [data.data] : [];
  return list; // cada item = um serviço
}

// Produtos v2: obter "tempo de postagem" por SKU
async function yampiProductsBySkusV2(skusIds) {
  if (!skusIds.length) return {};
  const unique = [...new Set(skusIds)];
  const url = `${process.env.YAMPI_BASE_URL}/v2/${process.env.YAMPI_ALIAS}/products?skus_ids=${encodeURIComponent(
    unique.join(",")
  )}`;
  const resp = await fetch(url, { headers: yampiHeaders() });
  if (!resp.ok) throw new Error(`PROD_${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
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
  return map; // { 1233: 2, 2123: 0 }
}

// ======================
// Rotas
// ======================

// Teste rápido (GET) - App Proxy
app.get("/proxy", (req, res) => {
  res.json({ message: "Proxy ativo!" });
});

// Cálculo REAL via Yampi (POST)
app.post("/proxy", async (req, res) => {
  try {
    const { postal_code, items = [] } = req.body || {};
    if (!postal_code || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "payload inválido" });
    }

    // Monta skus_ids repetindo conforme quantity
    // Recomendado: cada item trazer sku_id_yampi numérico
    const skusIds = [];
    for (const it of items) {
      const id = Number(it.sku_id_yampi ?? it.sku_id ?? it.sku);
      const qty = Number(it.quantity || 1);
      if (!Number.isFinite(id)) continue;
      for (let i = 0; i < qty; i++) skusIds.push(id);
    }
    if (!skusIds.length) {
      return res
        .status(400)
        .json({ error: "skus_ids ausentes; envie sku_id_yampi numérico por item" });
    }

    // 1) Cotar na Yampi
    const services = await yampiQuoteV2({ zipcode: postal_code, skusIds });

    // 2) Buscar tempo de postagem por SKU e pegar o MAIOR
    const postingBySku = await yampiProductsBySkusV2(skusIds);
    const postingMax = Object.values(postingBySku).reduce(
      (a, b) => Math.max(a, Number(b || 0)),
      0
    );

    // 3) Normalizar para o tema (paridade com checkout)
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
        name: s.service_display_name || s.service_name || s.title, // como no checkout
        code: s.service_id || s.service_code,
        price: priceCents ?? s.price,
        formatted_price:
          priceCents != null ? centsToBRL(priceCents) : s.formatted_price || s.price,
        deadline: totalDays ? `até ${totalDays} dia${totalDays > 1 ? "s" : ""}` : "",
      };
    });

    res.set("Cache-Control", "no-store");
    return res.json({ rates });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "falha no proxy", detail: String(e?.message || e) });
  }
});

// Página simples pra concluir instalação do app
app.get("/", (req, res) => {
  res.type("html").send(`
    <h1>Frete Carrinho Yampi Proxy</h1>
    <p>App instalado com sucesso.</p>
  `);
});

// Porta (Render define PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy ON na porta ${PORT}`));
