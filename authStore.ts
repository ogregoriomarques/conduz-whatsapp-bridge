import fs from "fs";
import path from "path";
import os from "os";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";
import { supabase } from "./supabase";

// Baileys guarda a sessão (credenciais + chaves) como vários arquivos JSON pequenos.
// Como o Render não garante disco persistente entre deploys/reinícios, espelhamos
// esses arquivos na tabela whatsapp_bridge_sessao pra sobreviver a restarts sem
// precisar escanear o QR code de novo toda vez.

const TABELA = "whatsapp_bridge_sessao";

async function baixarSessaoDoSupabase(pastaLocal: string) {
  const { data, error } = await supabase.from(TABELA).select("chave, valor");
  if (error) throw error;

  for (const linha of data ?? []) {
    const caminho = path.join(pastaLocal, linha.chave);
    fs.writeFileSync(caminho, JSON.stringify(linha.valor));
  }

  console.log(`[authStore] Restaurados ${data?.length ?? 0} arquivo(s) de sessão do Supabase.`);
}

async function sincronizarArquivo(pastaLocal: string, nomeArquivo: string) {
  const caminho = path.join(pastaLocal, nomeArquivo);

  if (!fs.existsSync(caminho)) {
    await supabase.from(TABELA).delete().eq("chave", nomeArquivo);
    return;
  }

  try {
    const conteudo = JSON.parse(fs.readFileSync(caminho, "utf8"));
    await supabase.from(TABELA).upsert({ chave: nomeArquivo, valor: conteudo, atualizado_em: new Date().toISOString() });
  } catch {
    // arquivo pode estar sendo escrito nesse instante; tenta de novo no próximo ciclo
  }
}

export async function criarAuthStorePersistente() {
  const pastaLocal = fs.mkdtempSync(path.join(os.tmpdir(), "wa-bridge-"));
  await baixarSessaoDoSupabase(pastaLocal);

  const { state, saveCreds } = await useMultiFileAuthState(pastaLocal);

  const arquivosConhecidos = new Set(fs.readdirSync(pastaLocal));

  // Sincroniza periodicamente qualquer arquivo novo/alterado/removido com o Supabase.
  const intervalo = setInterval(async () => {
    const arquivosAtuais = new Set(fs.readdirSync(pastaLocal));

    for (const arquivo of arquivosAtuais) {
      await sincronizarArquivo(pastaLocal, arquivo);
    }
    for (const arquivo of arquivosConhecidos) {
      if (!arquivosAtuais.has(arquivo)) {
        await supabase.from(TABELA).delete().eq("chave", arquivo);
      }
    }

    arquivosConhecidos.clear();
    for (const arquivo of arquivosAtuais) arquivosConhecidos.add(arquivo);
  }, 5000);

  async function limparSessao() {
    clearInterval(intervalo);
    fs.rmSync(pastaLocal, { recursive: true, force: true });
    await supabase.from(TABELA).delete().neq("chave", "");
  }

  return { state, saveCreds, limparSessao };
}
