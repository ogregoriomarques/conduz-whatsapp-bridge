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
import { criarAuthStorePersistente, listarVendedoresComSessao } from "./authStore";
import { rodarBackupSeNecessario } from "./backup";
import { processarGatilhoInatividade } from "./automacoes";

const PORT = process.env.PORT || 3001;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
const BUCKET_MIDIA = "whatsapp-midia";

type MidiaTipo = "imagem" | "audio" | "video" | "documento" | "localizacao" | "enquete";

// Cada vendedor conecta o próprio número — uma sessão Baileys independente por vendedor_id.
const sockets = new Map<string, WASocket>();
const conectando = new Set<string>();
// Guarda a função de limpar sessão (arquivos locais + linhas no Supabase) de cada vendedor
// conectado, pra /desconectar poder apagar a sessão de verdade e liberar um QR code novo pra
// um número diferente — sem isso, desconectar só derrubaria o socket e o próximo /conectar
// tentaria restaurar a sessão antiga em vez de gerar um QR novo.
const limpezasSessao = new Map<string, () => Promise<void>>();

function obterSocket(vendedorId: string): WASocket | null {
  return sockets.get(vendedorId) ?? null;
}

function limparNumero(jidOuTexto: string) {
  return jidOuTexto.replace(/@.*/, "").replace(/\D/g, "");
}

// Garante o "55" (código do Brasil) na frente do número. Sem isso, um número salvo só como
// DDD+telefone (ex: "51994439641", comum em planilhas importadas) é interpretado pelo WhatsApp
// como um número internacional cru — e "51" também é o código de país do Peru, então o contato
// aparece do outro lado com bandeira/país errado (Peru) em vez do DDD de Porto Alegre correto.
function garantirCodigoPaisBrasil(numero: string): string {
  if (numero.startsWith("55") && (numero.length === 12 || numero.length === 13)) return numero;
  if (numero.length === 10 || numero.length === 11) return `55${numero}`;
  return numero; // outro formato/país — não mexe.
}

// Confirma no WhatsApp se o número existe antes de mandar mensagem — sem isso, sendMessage() pode
// "ter sucesso" (retorna um id de mensagem) para um número que não é uma conta WhatsApp válida, e a
// mensagem nunca chega em lugar nenhum. Tenta também a variante clássica do 9º dígito de celulares
// brasileiros, já que alguns DDDs ainda causam ambiguidade nesse formato.
async function resolverJid(vendedorId: string, numeroBruto: string): Promise<string | null> {
  const sock = obterSocket(vendedorId);
  if (!sock) return null;

  const numero = garantirCodigoPaisBrasil(numeroBruto);

  const candidatos = new Set<string>([numero]);
  if (numero.startsWith("55") && numero.length === 13) {
    candidatos.add(numero.slice(0, 4) + numero.slice(5)); // remove o 9
  } else if (numero.startsWith("55") && numero.length === 12) {
    candidatos.add(numero.slice(0, 4) + "9" + numero.slice(4)); // adiciona o 9
  }

  for (const candidato of candidatos) {
    try {
      const resultados = await sock.onWhatsApp(candidato);
      const resultado = resultados?.[0];
      if (resultado?.exists && resultado.jid) return resultado.jid;
    } catch (err) {
      console.error(`[bridge] Erro ao verificar número ${candidato} no WhatsApp:`, err);
    }
  }
  return null;
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

async function atualizarStatus(
  vendedorId: string,
  dados: { conectado?: boolean; numero_conectado?: string | null; qr_code?: string | null; conectado_desde?: string | null }
) {
  const { error } = await supabase
    .from("whatsapp_bridge_status")
    .upsert({ vendedor_id: vendedorId, ...dados, atualizado_em: new Date().toISOString() }, { onConflict: "vendedor_id" });
  if (error) console.error("[bridge] Erro ao atualizar status:", error.message);
}

// Mensagens usam só o primeiro nome (ex: "João" em vez de "João da Silva Pereira") — mais
// natural e pessoal no WhatsApp do que o nome completo cadastrado no lead.
function primeiroNome(nomeCompleto: string | null | undefined): string {
  return (nomeCompleto ?? "").trim().split(/\s+/)[0] || "";
}

// Nome da empresa configurado em /empresa — substitui {empresa} nos templates, junto com {nome}.
async function obterNomeEmpresa(): Promise<string> {
  const { data } = await supabase.from("config_empresa").select("nome_empresa").eq("id", 1).maybeSingle();
  return data?.nome_empresa ?? "";
}

async function vincularLead(conversaId: string, vendedorId: string, telefone: string) {
  const ultimosDigitos = telefone.slice(-8);
  const { data: leadMatch } = await supabase
    .from("leads")
    .select("id")
    .eq("vendedor_id", vendedorId)
    .or(`telefone.ilike.%${ultimosDigitos}%,telefone_secundario.ilike.%${ultimosDigitos}%`)
    .limit(1)
    .maybeSingle();

  if (leadMatch) {
    await supabase.from("whatsapp_conversas").update({ lead_id: leadMatch.id }).eq("id", conversaId);
  }
}

const cacheConversas = new Map<string, { id: string; ultima_mensagem_em: string }>();

async function garantirConversa(vendedorId: string, telefone: string, nomeContato: string | null) {
  const chaveCache = `${vendedorId}:${telefone}`;
  const emCache = cacheConversas.get(chaveCache);
  if (emCache) return emCache;

  const { data: existente, error: erroSelect } = await supabase
    .from("whatsapp_conversas")
    .select("id, ultima_mensagem_em, lead_id, nome_contato")
    .eq("vendedor_id", vendedorId)
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
    cacheConversas.set(chaveCache, registro);
    return registro;
  }

  const { data: nova, error: erroInsert } = await supabase
    .from("whatsapp_conversas")
    .insert({
      telefone,
      vendedor_id: vendedorId,
      nome_contato: nomeContato,
      canal: "nao_oficial",
      ultima_mensagem_em: new Date(0).toISOString(),
    })
    .select("id, ultima_mensagem_em")
    .single();

  if (erroInsert || !nova) {
    console.error("[bridge] Erro ao criar conversa:", erroInsert?.message);
    return null;
  }

  await vincularLead(nova.id, vendedorId, telefone);
  cacheConversas.set(chaveCache, nova);
  return nova;
}

async function registrarMensagem(params: {
  vendedorId: string;
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
  const conversa = await garantirConversa(params.vendedorId, params.telefone, params.nomeContato);
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

async function sincronizarHistorico(vendedorId: string, chats: Chat[], contacts: Contact[], messages: WAMessage[]) {
  const nomesPorJid = new Map<string, string>();
  for (const c of contacts) {
    const nome = c.name || c.notify;
    if (c.id && nome) nomesPorJid.set(c.id, nome);
  }

  const chatsValidos = chats.filter((c) => c.id && c.id.endsWith("@s.whatsapp.net"));
  await processarLote(chatsValidos, 5, async (chat) => {
    const telefone = limparNumero(chat.id);
    if (!telefone) return;
    await garantirConversa(vendedorId, telefone, nomesPorJid.get(chat.id) ?? null);
  });

  // Histórico não baixa o arquivo de mídia em si (custo/tempo) — só o texto/legenda fica registrado.
  const msgsValidas = messages.filter((m) => m.message && m.key.remoteJid?.endsWith("@s.whatsapp.net"));
  await processarLote(msgsValidas, 5, async (msg) => {
    const telefone = limparNumero(msg.key.remoteJid ?? "");
    if (!telefone) return;
    await registrarMensagem({
      vendedorId,
      telefone,
      texto: extrairTexto(msg),
      nomeContato: nomesPorJid.get(msg.key.remoteJid ?? "") ?? msg.pushName ?? null,
      direcao: msg.key.fromMe ? "saida" : "entrada",
      waMessageId: msg.key.id ?? null,
      criadoEm: extrairTimestamp(msg),
      contarNaoLida: false,
    });
  });

  console.log(`[bridge] Vendedor ${vendedorId}: histórico sincronizado — ${chatsValidos.length} conversas, ${msgsValidas.length} mensagens processadas.`);
}

async function iniciarConexao(vendedorId: string) {
  if (conectando.has(vendedorId)) return sockets.get(vendedorId) ?? null;
  conectando.add(vendedorId);

  try {
    const { state, saveCreds, limparSessao } = await criarAuthStorePersistente(vendedorId);
    limpezasSessao.set(vendedorId, limparSessao);

    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: "warn" }),
      printQRInTerminal: false,
      syncFullHistory: true,
      defaultQueryTimeoutMs: 120_000,
    });

    sockets.set(vendedorId, sock);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messaging-history.set", async ({ chats, contacts, messages, isLatest }) => {
      console.log(`[bridge] Vendedor ${vendedorId}: lote de histórico (isLatest=${isLatest}): ${chats.length} chats, ${messages.length} mensagens.`);
      await sincronizarHistorico(vendedorId, chats as Chat[], contacts as Contact[], messages as WAMessage[]);
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrDataUrl = await QRCode.toDataURL(qr);
        await atualizarStatus(vendedorId, { conectado: false, qr_code: qrDataUrl });
        console.log(`[bridge] Vendedor ${vendedorId}: novo QR code gerado.`);
      }

      if (connection === "open") {
        const numero = sock.user?.id ? limparNumero(sock.user.id) : null;
        // Só reinicia a contagem de "aquecimento" se o número mudou de verdade — uma reconexão do
        // mesmo número (queda de rede, restart do serviço) não deve fazer o número perder o
        // histórico de dias já aquecidos.
        const { data: statusAnterior } = await supabase
          .from("whatsapp_bridge_status")
          .select("numero_conectado")
          .eq("vendedor_id", vendedorId)
          .maybeSingle();
        const numeroMudou = statusAnterior?.numero_conectado !== numero;
        await atualizarStatus(vendedorId, {
          conectado: true,
          numero_conectado: numero,
          qr_code: null,
          ...(numeroMudou ? { conectado_desde: new Date().toISOString() } : {}),
        });
        console.log(`[bridge] Vendedor ${vendedorId}: conectado ao WhatsApp:`, numero, numeroMudou ? "(número novo, aquecimento reiniciado)" : "");
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const deslogado = statusCode === DisconnectReason.loggedOut;

        sockets.delete(vendedorId);
        conectando.delete(vendedorId);
        console.log(`[bridge] Vendedor ${vendedorId}: conexão fechada. Deslogado?`, deslogado);

        if (deslogado) {
          // Deslogado pelo celular (ou via /desconectar) — limpa a sessão salva pra não tentar
          // restaurar credenciais mortas no próximo /conectar, o que impediria um QR code novo.
          const limpar = limpezasSessao.get(vendedorId);
          if (limpar) {
            await limpar().catch((err) => console.error(`[bridge] Erro ao limpar sessão de ${vendedorId}:`, err));
            limpezasSessao.delete(vendedorId);
          }
          await atualizarStatus(vendedorId, { conectado: false, numero_conectado: null, qr_code: null });
        } else {
          await atualizarStatus(vendedorId, { conectado: false });
          setTimeout(() => iniciarConexao(vendedorId), 3000);
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
        const textoMsg = extrairTexto(msg);

        // Envio multi-dispositivo gera ecos secundários sem conteúdo real (sender-key-distribution etc).
        // Como as mensagens que nós mesmos enviamos via /enviar já são gravadas ali mesmo, ignora esses ecos vazios.
        if (direcao === "saida" && textoMsg === "[mídia]" && !tipoMidia && !loc) continue;

        let midiaUpload: { url: string; nome: string } | null = null;
        if (tipoMidia) {
          midiaUpload = await baixarEUpload(msg, tipoMidia);
        }

        await registrarMensagem({
          vendedorId,
          telefone,
          texto: textoMsg,
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
  } finally {
    conectando.delete(vendedorId);
  }
}

// Processa um contato agendado de campanha por vez — o espaçamento entre disparos já foi
// pré-calculado pelo CRM (agendado_para); aqui só respeitamos o relógio e enviamos quando chegar a vez.
// Cada lead pertence a um vendedor, e o envio sai pela conexão WhatsApp *daquele* vendedor.
// Número recém-conectado sem histórico é o que mais chama atenção do sistema anti-spam do
// WhatsApp — por isso o volume diário sobe aos poucos conforme o número vai "envelhecendo" na
// conexão (não desde que o vendedor existe: reconecta o mesmo número não reinicia a contagem, só
// trocar de número reinicia). Depois de 14 dias, sem limite artificial daqui.
function limiteDiarioAquecimento(conectadoDesde: string | null): number {
  if (!conectadoDesde) return 20;
  const dias = (Date.now() - new Date(conectadoDesde).getTime()) / (24 * 60 * 60 * 1000);
  if (dias < 1) return 20;
  if (dias < 3) return 40;
  if (dias < 7) return 80;
  if (dias < 14) return 150;
  return 300;
}

async function processarCampanhas() {
  try {
    const { data: contatos, error } = await supabase
      .from("campanha_contatos")
      .select("id, tentativas, campanha:campanhas!inner(id, status, canal, template_id), lead:leads(nome, telefone, telefone_secundario, vendedor_id)")
      .eq("status_envio", "agendado")
      .lte("agendado_para", new Date().toISOString())
      .eq("campanha.status", "ativa")
      .eq("campanha.canal", "nao_oficial")
      .order("agendado_para", { ascending: true })
      .limit(1);

    if (error) {
      console.error("[bridge] Erro ao buscar campanhas agendadas:", error.message);
      return;
    }
    if (!contatos || contatos.length === 0) return;

    const contato = contatos[0] as unknown as {
      id: string;
      tentativas: number;
      campanha: { id: string; template_id: string | null };
      lead: { nome: string; telefone: string | null; telefone_secundario: string | null; vendedor_id: string } | null;
    };

    const telefoneDestino = (contato.lead?.telefone || contato.lead?.telefone_secundario || "").replace(/\D/g, "");
    const vendedorId = contato.lead?.vendedor_id;

    if (!telefoneDestino || !vendedorId) {
      await supabase
        .from("campanha_contatos")
        .update({ status_envio: "erro", erro: "Lead sem telefone ou sem vendedor responsável." })
        .eq("id", contato.id);
      return;
    }

    if (!obterSocket(vendedorId)) {
      await supabase
        .from("campanha_contatos")
        .update({ status_envio: "erro", erro: "O vendedor responsável por esse lead não tem WhatsApp conectado." })
        .eq("id", contato.id);
      return;
    }

    // Aquecimento: se o número ainda é novo e já bateu o limite do dia, não manda e nem marca erro —
    // só deixa "agendado" mesmo, o próximo ciclo tenta de novo (e o limite sobe conforme os dias passam).
    const { data: statusVendedor } = await supabase
      .from("whatsapp_bridge_status")
      .select("conectado_desde")
      .eq("vendedor_id", vendedorId)
      .maybeSingle();
    const limiteHoje = limiteDiarioAquecimento(statusVendedor?.conectado_desde ?? null);
    const inicioHojeBrasil = `${new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10)}T03:00:00.000Z`;
    // Se o número trocou hoje, a contagem começa em conectado_desde (não na meia-noite) — senão
    // mensagens enviadas mais cedo pelo número ANTIGO contariam contra o limite do número novo,
    // travando o disparo mesmo sem nenhuma mensagem real ter saído por esse número ainda.
    const inicioContagem =
      statusVendedor?.conectado_desde && statusVendedor.conectado_desde > inicioHojeBrasil
        ? statusVendedor.conectado_desde
        : inicioHojeBrasil;
    const { count: enviadasHojePorVendedor } = await supabase
      .from("whatsapp_mensagens")
      .select("id, conversa:whatsapp_conversas!inner(vendedor_id)", { count: "exact", head: true })
      .eq("direcao", "saida")
      .eq("conversa.vendedor_id", vendedorId)
      .gte("criado_em", inicioContagem);
    if ((enviadasHojePorVendedor ?? 0) >= limiteHoje) {
      console.log(`[bridge] Vendedor ${vendedorId}: limite diário de aquecimento atingido (${enviadasHojePorVendedor}/${limiteHoje}), aguardando.`);
      return;
    }

    await supabase.from("campanha_contatos").update({ status_envio: "enviando" }).eq("id", contato.id);

    // Sorteia uma entre as mensagens configuradas pra essa campanha — variar o texto reduz o risco
    // de bloqueio por "mesma mensagem em massa" (o que já causou queda de conexão antes).
    let mensagemTexto = "";
    const { data: variantes } = await supabase
      .from("campanha_templates")
      .select("template:templates_mensagem(mensagem)")
      .eq("campanha_id", contato.campanha.id);
    const mensagensDisponiveis = ((variantes ?? []) as unknown as { template: { mensagem: string } | null }[])
      .map((v) => v.template?.mensagem)
      .filter((m): m is string => Boolean(m));

    let mensagemBase: string | null = null;
    if (mensagensDisponiveis.length > 0) {
      mensagemBase = mensagensDisponiveis[Math.floor(Math.random() * mensagensDisponiveis.length)];
    } else if (contato.campanha.template_id) {
      const { data: template } = await supabase
        .from("templates_mensagem")
        .select("mensagem")
        .eq("id", contato.campanha.template_id)
        .single();
      mensagemBase = template?.mensagem ?? null;
    }

    if (mensagemBase) {
      const nomeEmpresa = await obterNomeEmpresa();
      mensagemTexto = mensagemBase
        .replace(/\{nome\}/g, primeiroNome(contato.lead?.nome))
        .replace(/\{empresa\}/g, nomeEmpresa);
    }

    try {
      const jid = await resolverJid(vendedorId, telefoneDestino);
      if (!jid) throw new Error(`Número ${telefoneDestino} não tem conta no WhatsApp.`);
      const resultado = await obterSocket(vendedorId)!.sendMessage(jid, { text: mensagemTexto });

      await supabase
        .from("campanha_contatos")
        .update({ status_envio: "enviado", enviado_em: new Date().toISOString() })
        .eq("id", contato.id);

      await registrarMensagem({
        vendedorId,
        telefone: telefoneDestino,
        texto: mensagemTexto,
        nomeContato: contato.lead?.nome ?? null,
        direcao: "saida",
        waMessageId: resultado?.key?.id ?? null,
        criadoEm: new Date().toISOString(),
        contarNaoLida: false,
      });

      console.log(`[bridge] Campanha: mensagem enviada para ${telefoneDestino} (vendedor ${vendedorId}).`);
    } catch (err) {
      console.error("[bridge] Erro ao enviar mensagem de campanha:", err);
      await supabase
        .from("campanha_contatos")
        .update({
          status_envio: "erro",
          erro: err instanceof Error ? err.message : "Erro ao enviar.",
          tentativas: (contato.tentativas ?? 0) + 1,
        })
        .eq("id", contato.id);
    }
  } catch (err) {
    console.error("[bridge] Erro no processador de campanhas:", err);
  }
}

// X dias depois de um lead virar "fechado", marca como cliente e manda mensagem pedindo indicação —
// uma vez só por lead (leads.indicacao_solicitada_em guarda o controle). Sai pela conexão do vendedor
// dono do lead.
async function processarGatilhoIndicacao() {
  try {
    // Cada vendedor tem sua própria config (ativo/dias/mensagem) — processa uma leva por vendedor.
    const { data: configs } = await supabase
      .from("config_automacao")
      .select("*")
      .eq("gatilho_indicacao_ativo", true)
      .not("gatilho_indicacao_template_id", "is", null);
    if (!configs || configs.length === 0) return;

    const nomeEmpresa = await obterNomeEmpresa();

    for (const config of configs) {
      const { data: template } = await supabase
        .from("templates_mensagem")
        .select("mensagem")
        .eq("id", config.gatilho_indicacao_template_id)
        .single();
      if (!template?.mensagem) continue;

      const limite = new Date();
      limite.setDate(limite.getDate() - config.gatilho_indicacao_dias);

      const { data: leadsElegiveis, error } = await supabase
        .from("leads")
        .select("id, nome, telefone, telefone_secundario, vendedor_id")
        .eq("vendedor_id", config.vendedor_id)
        .eq("etapa", "fechado")
        .is("indicacao_solicitada_em", null)
        .lt("atualizado_em", limite.toISOString())
        .limit(20);

      if (error) {
        console.error(
          `[automacao] Erro ao buscar leads elegíveis pra indicação (vendedor ${config.vendedor_id}):`,
          error.message
        );
        continue;
      }
      if (!leadsElegiveis || leadsElegiveis.length === 0) continue;

      for (const lead of leadsElegiveis) {
        const telefoneDestino = (lead.telefone || lead.telefone_secundario || "").replace(/\D/g, "");
        if (!telefoneDestino || !obterSocket(lead.vendedor_id)) continue;

        const mensagemTexto = template.mensagem.replace(/\{nome\}/g, primeiroNome(lead.nome)).replace(/\{empresa\}/g, nomeEmpresa);

        try {
          const jid = await resolverJid(lead.vendedor_id, telefoneDestino);
          if (!jid) throw new Error(`Número ${telefoneDestino} não tem conta no WhatsApp.`);
          const resultado = await obterSocket(lead.vendedor_id)!.sendMessage(jid, { text: mensagemTexto });

          await supabase
            .from("leads")
            .update({ cliente: true, indicacao_solicitada_em: new Date().toISOString() })
            .eq("id", lead.id);

          await registrarMensagem({
            vendedorId: lead.vendedor_id,
            telefone: telefoneDestino,
            texto: mensagemTexto,
            nomeContato: lead.nome ?? null,
            direcao: "saida",
            waMessageId: resultado?.key?.id ?? null,
            criadoEm: new Date().toISOString(),
            contarNaoLida: false,
          });

          console.log(`[automacao] Indicação solicitada para ${lead.nome} (${telefoneDestino}).`);
        } catch (err) {
          console.error(`[automacao] Erro ao enviar pedido de indicação para ${telefoneDestino}:`, err);
        }
      }
    }
  } catch (err) {
    console.error("[automacao] Erro no gatilho de indicação:", err);
  }
}

// O plano free do Render hiberra o serviço depois de ~15min sem tráfego HTTP externo — e, hibernado,
// NADA aqui roda (nem disparo de campanha, nem automações, nem a conexão do WhatsApp fica de pé) até
// alguma requisição de fora "acordar" o container de novo. Esse ping periódico pro próprio endereço
// público conta como tráfego externo e evita a hibernação na grande maioria das vezes. Não é garantia
// (um deploy, manutenção do Render, ou pico de uso ainda pode causar um cold start pontual) — o único
// jeito 100% confiável é um plano pago do Render, que nunca hiberna.
const URL_PUBLICA = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

function manterAcordado() {
  fetch(`${URL_PUBLICA}/health`).catch((err) => console.error("[keep-alive] Erro ao pingar a si mesmo:", err));
}

async function main() {
  const vendedoresComSessao = await listarVendedoresComSessao();
  console.log(`[bridge] Reconectando ${vendedoresComSessao.length} sessão(ões) salva(s)...`);
  await Promise.all(vendedoresComSessao.map((vendedorId) => iniciarConexao(vendedorId)));

  // 45s (era 20s) — o Supabase está no plano free (Nano), já perto do limite de CPU/RAM, e essa
  // consulta roda o tempo todo, 24h, mesmo sem nenhuma campanha ativa. O espaçamento real entre
  // mensagens já é medido em dezenas de segundos, então checar a cada 45s não atrasa nada na prática.
  setInterval(processarCampanhas, 45_000);
  setInterval(manterAcordado, 10 * 60 * 1000);

  rodarBackupSeNecessario().catch((err) => console.error("[backup] Erro no backup inicial:", err));
  processarGatilhoInatividade().catch((err) => console.error("[automacao] Erro no gatilho inicial:", err));
  processarGatilhoIndicacao().catch((err) => console.error("[automacao] Erro no gatilho de indicação inicial:", err));
  // 3h (era 1h) — nenhuma dessas rotinas precisa de precisão de hora em hora (backup já se
  // autolimita a uma vez por dia; os gatilhos de inatividade/indicação lidam com prazos de dias),
  // e cada rodada varre leads inteiros. Reduzir a frequência tira uma fonte periódica de carga do
  // banco, que está no plano free perto do limite de CPU/RAM.
  setInterval(() => {
    rodarBackupSeNecessario().catch((err) => console.error("[backup] Erro no backup:", err));
    processarGatilhoInatividade().catch((err) => console.error("[automacao] Erro no gatilho:", err));
    processarGatilhoIndicacao().catch((err) => console.error("[automacao] Erro no gatilho de indicação:", err));
  }, 3 * 60 * 60 * 1000);

  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Inicia (ou reinicia) a conexão de um vendedor específico — gera QR code se ainda não tiver sessão salva.
  app.post("/conectar", async (req, res) => {
    if (req.header("x-bridge-key") !== BRIDGE_API_KEY) {
      return res.status(401).json({ error: "Não autorizado." });
    }

    const { vendedorId } = req.body as { vendedorId?: string };
    if (!vendedorId) {
      return res.status(400).json({ error: "vendedorId é obrigatório." });
    }

    if (obterSocket(vendedorId)) {
      return res.json({ ok: true, jaConectado: true });
    }

    iniciarConexao(vendedorId).catch((err) => console.error(`[bridge] Erro ao iniciar conexão de ${vendedorId}:`, err));
    res.json({ ok: true, jaConectado: false });
  });

  // Derruba a sessão atual e apaga as credenciais salvas — depois de chamar isso, o próximo
  // /conectar gera um QR code do zero (pra trocar de número, por exemplo).
  app.post("/desconectar", async (req, res) => {
    if (req.header("x-bridge-key") !== BRIDGE_API_KEY) {
      return res.status(401).json({ error: "Não autorizado." });
    }

    const { vendedorId } = req.body as { vendedorId?: string };
    if (!vendedorId) {
      return res.status(400).json({ error: "vendedorId é obrigatório." });
    }

    const sock = obterSocket(vendedorId);
    if (!sock) {
      // Sem sessão ativa — ainda assim garante que sessão salva/status não fiquem presos.
      const limpar = limpezasSessao.get(vendedorId);
      if (limpar) {
        await limpar().catch(() => {});
        limpezasSessao.delete(vendedorId);
      }
      await atualizarStatus(vendedorId, { conectado: false, numero_conectado: null, qr_code: null });
      return res.json({ ok: true, jaDesconectado: true });
    }

    try {
      // sock.logout() dispara o evento connection.update (close, loggedOut) que já cuida de
      // limpar a sessão salva e o status — não duplica a limpeza aqui.
      await sock.logout();
    } catch (err) {
      console.error(`[bridge] Erro ao desconectar ${vendedorId}, limpando manualmente:`, err);
      sockets.delete(vendedorId);
      conectando.delete(vendedorId);
      const limpar = limpezasSessao.get(vendedorId);
      if (limpar) {
        await limpar().catch(() => {});
        limpezasSessao.delete(vendedorId);
      }
      await atualizarStatus(vendedorId, { conectado: false, numero_conectado: null, qr_code: null });
    }

    res.json({ ok: true });
  });

  app.post("/enviar", async (req, res) => {
    if (req.header("x-bridge-key") !== BRIDGE_API_KEY) {
      return res.status(401).json({ error: "Não autorizado." });
    }

    const {
      vendedorId,
      telefone,
      texto,
      midiaUrl,
      midiaTipo,
      midiaNome,
      midiaTipoConteudo,
      latitude,
      longitude,
      enquete,
    } = req.body as {
      vendedorId?: string;
      telefone?: string;
      texto?: string;
      midiaUrl?: string;
      midiaTipo?: MidiaTipo;
      midiaNome?: string;
      midiaTipoConteudo?: string;
      latitude?: number;
      longitude?: number;
      enquete?: { pergunta: string; opcoes: string[] };
    };

    if (!vendedorId) {
      return res.status(400).json({ error: "vendedorId é obrigatório." });
    }
    if (!telefone) {
      return res.status(400).json({ error: "telefone é obrigatório." });
    }
    if (!texto && !midiaUrl && latitude === undefined && !enquete) {
      return res.status(400).json({ error: "informe texto, mídia, localização ou enquete." });
    }
    const sock = obterSocket(vendedorId);
    if (!sock) {
      return res.status(503).json({ error: "Seu WhatsApp não está conectado." });
    }

    try {
      const numero = telefone.replace(/\D/g, "");
      const jid = await resolverJid(vendedorId, numero);
      if (!jid) {
        return res.status(422).json({ error: `Número ${numero} não tem conta no WhatsApp.` });
      }

      let conteudo: AnyMessageContent;
      if (midiaUrl && midiaTipo === "imagem") {
        conteudo = { image: { url: midiaUrl }, caption: texto, mimetype: midiaTipoConteudo };
      } else if (midiaUrl && midiaTipo === "video") {
        conteudo = { video: { url: midiaUrl }, caption: texto, mimetype: midiaTipoConteudo || "video/mp4" };
      } else if (midiaUrl && midiaTipo === "audio") {
        conteudo = { audio: { url: midiaUrl }, mimetype: midiaTipoConteudo || "audio/mp4" };
      } else if (midiaUrl && midiaTipo === "documento") {
        conteudo = {
          document: { url: midiaUrl },
          mimetype: midiaTipoConteudo || "application/octet-stream",
          fileName: midiaNome || "arquivo",
        };
      } else if (latitude !== undefined && longitude !== undefined) {
        conteudo = { location: { degreesLatitude: latitude, degreesLongitude: longitude } };
      } else if (enquete) {
        conteudo = { poll: { name: enquete.pergunta, values: enquete.opcoes, selectableCount: 1 } };
      } else {
        conteudo = { text: texto || "" };
      }

      const resultado = await sock.sendMessage(jid, conteudo);
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
