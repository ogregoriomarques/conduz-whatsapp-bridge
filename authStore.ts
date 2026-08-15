import fs from "fs";
import path from "path";
import os from "os";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";
import { supabase } from "./supabase";

// Baileys guarda a sessão (credenciais + chaves) como vários arquivos JSON pequenos.
// Como o Render não garante disco persistente entre deploys/reinícios, espelhamos
// esses arquivos na tabela whatsapp_bridge_sessao pra sobreviver a restarts sem
// precisar escanear o QR code de novo toda vez. Cada vendedor tem seu próprio
// conjunto de chaves (mesma tabela, particionada por vendedor_id).

const TABELA = "whatsapp_bridge_sessao";

async function baixarSessaoDoSupabase(vendedorId: string, pastaLocal: string) {
  const { data, error } = await supabase.from(TABELA).select("chave, valor").eq("vendedor_id", vendedorId);
  if (error) throw error;

  for (const linha of data ?? []) {
    const caminho = path.join(pastaLocal, linha.chave);
    fs.writeFileSync(caminho, JSON.stringify(linha.valor));
  }

  console.log(`[authStore] Vendedor ${vendedorId}: restaurados ${data?.length ?? 0} arquivo(s) de sessão do Supabase.`);
}

async function sincronizarArquivo(vendedorId: string, pastaLocal: string, nomeArquivo: string) {
  const caminho = path.join(pastaLocal, nomeArquivo);

  if (!fs.existsSync(caminho)) {
    await supabase.from(TABELA).delete().eq("vendedor_id", vendedorId).eq("chave", nomeArquivo);
    return;
  }

  try {
    const conteudo = JSON.parse(fs.readFileSync(caminho, "utf8"));
    await supabase
      .from(TABELA)
      .upsert({ vendedor_id: vendedorId, chave: nomeArquivo, valor: conteudo, atualizado_em: new Date().toISOString() });
  } catch {
    // arquivo pode estar sendo escrito nesse instante; tenta de novo no próximo ciclo
  }
}

export async function criarAuthStorePersistente(vendedorId: string) {
  const pastaLocal = fs.mkdtempSync(path.join(os.tmpdir(), `wa-bridge-${vendedorId}-`));
  await baixarSessaoDoSupabase(vendedorId, pastaLocal);

  const { state, saveCreds } = await useMultiFileAuthState(pastaLocal);

  const arquivosConhecidos = new Set(fs.readdirSync(pastaLocal));

  // Sincroniza periodicamente qualquer arquivo novo/alterado/removido com o Supabase.
  const intervalo = setInterval(async () => {
    const arquivosAtuais = new Set(fs.readdirSync(pastaLocal));

    for (const arquivo of arquivosAtuais) {
      await sincronizarArquivo(vendedorId, pastaLocal, arquivo);
    }
    for (const arquivo of arquivosConhecidos) {
      if (!arquivosAtuais.has(arquivo)) {
        await supabase.from(TABELA).delete().eq("vendedor_id", vendedorId).eq("chave", arquivo);
      }
    }

    arquivosConhecidos.clear();
    for (const arquivo of arquivosAtuais) arquivosConhecidos.add(arquivo);
  }, 5000);

  async function limparSessao() {
    clearInterval(intervalo);
    fs.rmSync(pastaLocal, { recursive: true, force: true });
    await supabase.from(TABELA).delete().eq("vendedor_id", vendedorId);
  }

  return { state, saveCreds, limparSessao };
}

// Lista os vendedores que já têm alguma sessão salva (pra reconectar sozinho ao subir o serviço).
export async function listarVendedoresComSessao(): Promise<string[]> {
  const { data, error } = await supabase.from(TABELA).select("vendedor_id");
  if (error) {
    console.error("[authStore] Erro ao listar vendedores com sessão:", error.message);
    return [];
  }
  return Array.from(new Set((data ?? []).map((r) => r.vendedor_id as string)));
}
