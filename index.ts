import "dotenv/config";
import express from "express";
import QRCode from "qrcode";
import makeWASocket, { DisconnectReason, type WASocket } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import { supabase } from "./supabase";
import { criarAuthStorePersistente } from "./authStore";

const PORT = process.env.PORT || 3001;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;

let socketAtual: WASocket | null = null;

function limparNumero(jidOuTexto: string) {
  return jidOuTexto.replace(/@.*/, "").replace(/\D/g, "");
}

async function atualizarStatus(dados: { conectado?: boolean; numero_conectado?: string | null; qr_code?: string | null }) {
  await supabase
    .from("whatsapp_bridge_status")
    .update({ ...dados, atualizado_em: new Date().toISOString() })
    .eq("id", 1);
}

async function registrarMensagemRecebida(telefone: string, texto: string, nomeContato: string | null, direcao: "entrada" | "saida") {
  const { data: conversa } = await supabase
    .from("whatsapp_conversas")
    .upsert(
      {
        telefone,
        nome_contato: nomeContato,
        canal: "nao_oficial",
        ultima_mensagem: texto,
        ultima_mensagem_em: new Date().toISOString(),
      },
      { onConflict: "telefone" }
    )
    .select()
    .single();

  if (!conversa) return;

  if (!conversa.lead_id) {
    const ultimosDigitos = telefone.slice(-8);
    const { data: leadMatch } = await supabase
      .from("leads")
      .select("id")
      .or(`telefone.ilike.%${ultimosDigitos}%,telefone_secundario.ilike.%${ultimosDigitos}%`)
      .limit(1)
      .maybeSingle();

    if (leadMatch) {
      await supabase.from("whatsapp_conversas").update({ lead_id: leadMatch.id }).eq("id", conversa.id);
    }
  }

  await supabase.from("whatsapp_mensagens").insert({
    conversa_id: conversa.id,
    direcao,
    texto,
    status: direcao === "entrada" ? "entregue" : "enviado",
  });

  if (direcao === "entrada") {
    await supabase
      .from("whatsapp_conversas")
      .update({ nao_lidas: (conversa.nao_lidas ?? 0) + 1 })
      .eq("id", conversa.id);
  }
}

async function iniciarConexao() {
  const { state, saveCreds } = await criarAuthStorePersistente();

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "warn" }),
    printQRInTerminal: false,
  });

  socketAtual = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr);
      await atualizarStatus({ conectado: false, qr_code: qrDataUrl });
      console.log("[bridge] Novo QR code gerado.");
    }

    if (connection === "open") {
      const numero = sock.user?.id ? limparNumero(sock.user.id) : null;
      await atualizarStatus({ conectado: true, numero_conectado: numero, qr_code: null });
      console.log("[bridge] Conectado ao WhatsApp:", numero);
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const deslogado = statusCode === DisconnectReason.loggedOut;

      await atualizarStatus({ conectado: false });
      console.log("[bridge] Conexão fechada. Deslogado?", deslogado);

      if (!deslogado) {
        setTimeout(iniciarConexao, 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.remoteJid?.endsWith("@g.us")) continue; // ignora grupos

      const telefone = limparNumero(msg.key.remoteJid ?? "");
      if (!telefone) continue;

      const texto =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        "[mídia]";

      const direcao = msg.key.fromMe ? "saida" : "entrada";
      await registrarMensagemRecebida(telefone, texto, msg.pushName ?? null, direcao);
    }
  });

  return sock;
}

async function main() {
  await iniciarConexao();

  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.post("/enviar", async (req, res) => {
    if (req.header("x-bridge-key") !== BRIDGE_API_KEY) {
      return res.status(401).json({ error: "Não autorizado." });
    }

    const { telefone, texto } = req.body as { telefone?: string; texto?: string };
    if (!telefone || !texto) {
      return res.status(400).json({ error: "telefone e texto são obrigatórios." });
    }

    if (!socketAtual) {
      return res.status(503).json({ error: "WhatsApp não conectado." });
    }

    try {
      const numero = telefone.replace(/\D/g, "");
      const jid = `${numero}@s.whatsapp.net`;
      const resultado = await socketAtual.sendMessage(jid, { text: texto });
      res.json({ ok: true, id: resultado?.key?.id ?? null });
    } catch (err) {
      console.error("[bridge] Erro ao enviar:", err);
      res.status(500).json({ error: "Erro ao enviar mensagem." });
    }
  });

  app.listen(PORT, () => {
    console.log(`[bridge] Servidor HTTP rodando na porta ${PORT}`);
  });
}

main().catch((err) => {
  console.error("[bridge] Erro fatal:", err);
  process.exit(1);
});
