import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// Rota que a Shopify chama via App Proxy (teste rápido)
app.get("/proxy", (req, res) => {
  res.json({ message: "Proxy ativo!" });
});

// Exemplo de POST (depois você troca pela chamada REAL à Yampi)
app.post("/proxy", async (req, res) => {
  try {
    const { postal_code, items = [] } = req.body || {};
    if (!postal_code) return res.status(400).json({ error: "postal_code é obrigatório" });

    // TODO: chamar sua API de frete da Yampi usando envs:
    // const resp = await fetch(process.env.YAMPI_FRETE_URL, { ...headers com process.env.YAMPI_TOKEN ... })

    // Mock temporário
    const rates = [
      { name: "PAC", price: 1990, formatted_price: "R$ 19,90", deadline: "5 dias úteis" },
      { name: "SEDEX", price: 2990, formatted_price: "R$ 29,90", deadline: "2 dias úteis" }
    ];

    res.json({ rates });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "falha no proxy" });
  }
});

// Porta que o Render define via variável PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy ON na porta ${PORT}`));
