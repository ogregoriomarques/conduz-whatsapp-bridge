import "dotenv/config";
import express from "express";
import QRCode from "qrcode";
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  normalizeMessageContent,
  type WASocket,
  type WAMessage,
  type Chat,
  type Contact,
  type AnyMessageContent,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import { randomUUID } from "crypto";
import { supabase } from "./supabase";
import { criarAuthStorePersistente } from "./authStore";

const PORT = process.env.PORT || 3001;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
const BUCKET_MIDIA = "whatsapp-midia";

type MidiaTipo = "imagem" | "audio" | "video" | "documento" | "localizacao" | "enquete";

let socketAtual: WASocket | null = null;

function limparNumero(jidOuTexto: string) {
  return jidOuTexto.replace(/@.*/, "").replace(/\D/g, "");
}

// Mensagens enviadas pelo próprio dispositivo (fromMe) e algumas outras variações
// chegam embrulhadas em deviceSentMessage/ephemeralMessage/viewOnceMessage — desembrulha antes de ler.
function conteudoNormalizado(msg: WAMessage) {
  if (!msg.message) return null;
  return normalizeMessageContent(msg.message);
}

function extrairTexto(msg: WAMessage): string {
  const m = conteudoNormalizado(msg);
  if (!m) return "[mídia]";
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return m.imageMessage.caption || "[imagem]";
  if (m.videoMessage) return m.videoMessage.caption || "[vídeo]";
  if (m.audioMessage) return m.audioMessage.ptt ? "[áudio]" : "[arquivo de áudio]";
  if (m.documentMessage) return `[documento] ${m.documentMessage.fileName ?? ""}`.trim();
  if (m.stickerMessage) return "[figurinha]";
  if (m.locationMessage) return "[localização]";
  if (m.contactMessage) return "[contato compartilhado]";
  return "[mídia]";
}

function detectarTipoMidia(msg: WAMessage): MidiaTipo | null {
  const m = conteudoNormalizado(msg);
  if (!m) return null;
  if (m.imageMessage) return "imagem";
  if (m.videoMessage) return "video";
  if (m.audioMessage) return "audio";
  if (m.documentMessage) return "documento";
  return null;
}

function extensaoPara(tipo: MidiaTipo, mimetype?: string | null): string {
  if (mimetype?.includes("/")) {
    const sub = mimetype.split("/")[1]?.split(";")[0];
    if (sub) return sub;
  }
  return tipo === "imagem" ? "jpg" : tipo === "video" ? "mp4" : tipo === "audio" ? "ogg" : "bin";
}

async function baixarEUpload(msg: WAMessage, tipo: MidiaTipo): Promise<{ url: string; nome: string } | null> {
  try {
    const buffer = (await downloadMediaMessage(msg, "buffer", {})) as Buffer;
    const m = conteudoNormalizado(msg)!;
    const mimetype =
      tipo === "imagem" ? m.imageMessage?.mimetype
      : tipo === "video" ? m.videoMessage?.mimetype
      : tipo === "audio" ? m.audioMessage?.mimetype
      : m.documentMessage?.mimetype;
    const nomeOriginal = tipo === "documento" ? m.documentMessage?.fileName ?? undefined : undefined;
    const ext = extensaoPara(tipo, mimetype ?? undefined);
    const caminho = `entrada/${randomUUID()}.${ext}`;

    const { error } = await supabase.storage.from(BUCKET_MIDIA).upload(caminho, buffer, {
      contentType: mimetype ?? "application/octet-stream",
      upsert: false,
    });
    if (error) {
      console.error("[bridge] Erro ao subir mídia recebida:", error.message);
      return null;
    }

    const { data } = supabase.storage.from(BUCKET_MIDIA).getPublicUrl(caminho);
    return { url: data.publicUrl, nome: nomeOriginal ?? caminho.split("/").pop()! };
  } catch (err) {
    console.error("[bridge] Erro ao baixar mídia:", err);
    return null;
  }
}

function extrairTimestamp(msg: WAMessage): string {
  const ts = msg.messageTimestamp;
  if (!ts) return new Date().toISOString();
  const millis = (typeof ts === "number" ? ts : Number(ts)) * 1000;
  return new Date(millis).toISOString();
}

async function atualizarStatus(dados: { conectado?: boolean; numero_conectado?: string | null; qr_code?: string | null }) {
  const { error } = await supabase
    .from("whatsapp_bridge_status")
    .update({ ...dados, atualizado_em: new Date().toISOString() })
    .eq("id", 1);
  if (error) console.error("[bridge] Erro ao atualizar status:", error.message);
}

async function vincularLead(conversaId: string, telefone: string) {
  const ultimosDigitos = telefone.slice(-8);
  const { data: leadMatch } = await supabase
    .from("leads")
    .select("id")
    .or(`telefone.ilike.%${ultimosDigitos}%,telefone_secundario.ilike.%${ultimosDigitos}%`)
    .limit(1)
    .maybeSingle();

  if (leadMatch) {
    await supabase.from("whatsapp_conversas").update({ lead_id: leadMatch.id }).eq("id", conversaId);
  }
}

const cacheConversas = new Map<string, { id: string; ultima_mensagem_em: string }>();

async function garantirConversa(telefone: string, nomeContato: string | null) {
  const emCache = cacheConversas.get(telefone);
  if (emCache) return emCache;

  const { data: existente, error: erroSelect } = await supabase
    .from("whatsapp_conversas")
    .select("id, ultima_mensagem_em, lead_id, nome_contato")
    .eq("telefone", telefone)
    .maybeSingle();

  if (erroSelect) {
    console.error("[bridge] Erro ao buscar conversa:", erroSelect.message);
    return null;
  }

  if (existente) {
    if (nomeContato && !existente.nome_contato) {
      await supabase.from("whatsapp_conversas").update({ nome_contato: nomeContato }).eq("id", existente.id);
    }
    const registro = { id: existente.id, ultima_mensagem_em: existente.ultima_mensagem_em };
    cacheConversas.set(telefone, registro);
    return registro;
  }

  const { data: nova, error: erroInsert } = await supabase
    .from("whatsapp_conversas")
    .insert({ telefone, nome_contato: nomeContato, canal: "nao_oficial", ultima_mensagem_em: new Date(0).toISOString() })
    .select("id, ultima_mensagem_em")
    .single();

  if (erroInsert || !nova) {
    console.error("[bridge] Erro ao criar conversa:", erroInsert?.message);
    return null;
  }

  await vincularLead(nova.id, telefone);
  cacheConversas.set(telefone, nova);
  return nova;
}

async function registrarMensagem(params: {
  telefone: string;
  texto: string;
  nomeContato: string | null;
  direcao: "entrada" | "saida";
  waMessageId: string | null;
  criadoEm: string;
  contarNaoLida: boolean;
  midiaUrl?: string | null;
  midiaTipo?: MidiaTipo | null;
  midiaNome?: string | null;
  midiaLat?: number | null;
  midiaLng?: number | null;
}) {
  const conversa = await garantirConversa(params.telefone, params.nomeContato);
  if (!conversa) return;

  const { error: erroMsg } = await supabase.from("whatsapp_mensagens").upsert(
    {
      conversa_id: conversa.id,
      wa_message_id: params.waMessageId,
      direcao: params.direcao,
      texto: params.texto,
      status: params.direcao === "entrada" ? "entregue" : "enviado",
      criado_em: params.criadoEm,
      midia_url: params.midiaUrl ?? null,
      midia_tipo: params.midiaTipo ?? null,
      midia_nome: params.midiaNome ?? null,
      midia_lat: params.midiaLat ?? null,
      midia_lng: params.midiaLng ?? null,
    },
    { onConflict: "wa_message_id", ignoreDuplicates: true }
  );
  if (erroMsg) console.error("[bridge] Erro ao gravar mensagem:", erroMsg.message);

  if (params.criadoEm > conversa.ultima_mensagem_em) {
    const atualizacao: Record<string, unknown> = {
      ultima_mensagem: params.texto,
      ultima_mensagem_em: params.criadoEm,
    };
    if (params.contarNaoLida) {
      const { data: atual } = await supabase.from("whatsapp_conversas").select("nao_lidas").eq("id", conversa.id).single();
      atualizacao.nao_lidas = (atual?.nao_lidas ?? 0) + 1;
    }
    const { error: erroConversa } = await supabase.from("whatsapp_conversas").update(atualizacao).eq("id", conversa.id);
    if (erroConversa) console.error("[bridge] Erro ao atualizar conversa:", erroConversa.message);
    conversa.ultima_mensagem_em = params.criadoEm;
  }
}

async function processarLote<T>(itens: T[], concorrencia: number, tarefa: (item: T) => Promise<void>) {
  let indice = 0;
  async function worker() {
    while (indice < itens.length) {
      const atual = itens[indice++];
      try {
        await tarefa(atual);
      } catch (err) {
        console.error("[bridge] Erro ao processar item do histórico:", err);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concorrencia, itens.length) }, worker));
}

async function sincronizarHistorico(chats: Chat[], contacts: Contact[], messages: WAMessage[]) {
  const nomesPorJid = new Map<string, string>();
  for (const c of contacts) {
    const nome = c.name || c.notify;
    if (c.id && nome) nomesPorJid.set(c.id, nome);
  }

  const chatsValidos = chats.filter((c) => c.id && c.id.endsWith("@s.whatsapp.net"));
  await processarLote(chatsValidos, 5, async (chat) => {
    const telefone = limparNumero(chat.id);
    if (!telefone) return;
    await garantirConversa(telefone, nomesPorJid.get(chat.id) ?? null);
  });

  // Histórico não baixa o arquivo de mídia em si (custo/tempo) — só o texto/legenda fica registrado.
  const msgsValidas = messages.filter((m) => m.message && m.key.remoteJid?.endsWith("@s.whatsapp.net"));
  await processarLote(msgsValidas, 5, async (msg) => {
    const telefone = limparNumero(msg.key.remoteJid ?? "");
    if (!telefone) return;
    await registrarMensagem({
      telefone,
      texto: extrairTexto(msg),
      nomeContato: nomesPorJid.get(msg.key.remoteJid ?? "") ?? msg.pushName ?? null,
      direcao: msg.key.fromMe ? "saida" : "entrada",
      waMessageId: msg.key.id ?? null,
      criadoEm: extrairTimestamp(msg),
      contarNaoLida: false,
    });
  });

  console.log(`[bridge] Histórico sincronizado: ${chatsValidos.length} conversas, ${msgsValidas.length} mensagens processadas.`);
}

async function iniciarConexao() {
  const { state, saveCreds } = await criarAuthStorePersistente();

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "warn" }),
    printQRInTerminal: false,
    syncFullHistory: true,
    defaultQueryTimeoutMs: 120_000,
  });

  socketAtual = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messaging-history.set", async ({ chats, contacts, messages, isLatest }) => {
    console.log(`[bridge] Recebido lote de histórico (isLatest=${isLatest}): ${chats.length} chats, ${messages.length} mensagens.`);
    await sincronizarHistorico(chats as Chat[], contacts as Contact[], messages as WAMessage[]);
  });

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
      if (!msg.message || !msg.key.remoteJid?.endsWith("@s.whatsapp.net")) continue; // ignora grupos, status e @lid

      const telefone = limparNumero(msg.key.remoteJid ?? "");
      if (!telefone) continue;

      const direcao = msg.key.fromMe ? "saida" : "entrada";
      const loc = conteudoNormalizado(msg)?.locationMessage;
      const tipoMidia = detectarTipoMidia(msg);
      let midiaUpload: { url: string; nome: string } | null = null;
      if (tipoMidia) {
        midiaUpload = await baixarEUpload(msg, tipoMidia);
      }

      await registrarMensagem({
        telefone,
        texto: extrairTexto(msg),
        nomeContato: msg.pushName ?? null,
        direcao,
        waMessageId: msg.key.id ?? null,
        criadoEm: extrairTimestamp(msg),
        contarNaoLida: direcao === "entrada",
        midiaUrl: midiaUpload?.url ?? null,
        midiaTipo: midiaUpload ? tipoMidia : loc ? "localizacao" : null,
        midiaNome: midiaUpload?.nome ?? null,
        midiaLat: loc?.degreesLatitude ?? null,
        midiaLng: loc?.degreesLongitude ?? null,
      });
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

    const {
      telefone,
      texto,
      midiaUrl,
      midiaTipo,
      midiaNome,
      latitude,
      longitude,
      enquete,
    } = req.body as {
      telefone?: string;
      texto?: string;
      midiaUrl?: string;
      midiaTipo?: MidiaTipo;
      midiaNome?: string;
      latitude?: number;
      longitude?: number;
      enquete?: { pergunta: string; opcoes: string[] };
    };

    if (!telefone) {
      return res.status(400).json({ error: "telefone é obrigatório." });
    }
    if (!texto && !midiaUrl && latitude === undefined && !enquete) {
      return res.status(400).json({ error: "informe texto, mídia, localização ou enquete." });
    }
    if (!socketAtual) {
      return res.status(503).json({ error: "WhatsApp não conectado." });
    }

    try {
      const numero = telefone.replace(/\D/g, "");
      const jid = `${numero}@s.whatsapp.net`;

      let conteudo: AnyMessageContent;
      if (midiaUrl && midiaTipo === "imagem") {
        conteudo = { image: { url: midiaUrl }, caption: texto };
      } else if (midiaUrl && midiaTipo === "video") {
        conteudo = { video: { url: midiaUrl }, caption: texto };
      } else if (midiaUrl && midiaTipo === "audio") {
        conteudo = { audio: { url: midiaUrl }, mimetype: "audio/mp4" };
      } else if (midiaUrl && midiaTipo === "documento") {
        conteudo = { document: { url: midiaUrl }, mimetype: "application/octet-stream", fileName: midiaNome || "arquivo" };
      } else if (latitude !== undefined && longitude !== undefined) {
        conteudo = { location: { degreesLatitude: latitude, degreesLongitude: longitude } };
      } else if (enquete) {
        conteudo = { poll: { name: enquete.pergunta, values: enquete.opcoes, selectableCount: 1 } };
      } else {
        conteudo = { text: texto || "" };
      }

      const resultado = await socketAtual.sendMessage(jid, conteudo);
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
