import { supabase } from "./supabase";

const TABELAS_BACKUP = [
  "profiles",
  "leads",
  "interacoes",
  "templates_mensagem",
  "campanhas",
  "campanha_contatos",
  "motivos_perda",
  "tags",
  "lead_tags",
  "atividades",
  "lead_anexos",
  "whatsapp_conversas",
  "whatsapp_mensagens",
];

const BUCKET_BACKUP = "backups";
const RETENCAO_DIAS = 14;

async function buscarTabelaCompleta(tabela: string): Promise<unknown[]> {
  const linhas: unknown[] = [];
  const tamanhoPagina = 1000;
  let de = 0;
  for (;;) {
    const { data, error } = await supabase.from(tabela).select("*").range(de, de + tamanhoPagina - 1);
    if (error) {
      console.error(`[backup] Erro ao ler ${tabela}:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;
    linhas.push(...data);
    if (data.length < tamanhoPagina) break;
    de += tamanhoPagina;
  }
  return linhas;
}

export async function rodarBackupSeNecessario() {
  const hoje = new Date().toISOString().slice(0, 10);

  const { data: existente } = await supabase.storage.from(BUCKET_BACKUP).list(hoje, { limit: 1 });
  if (existente && existente.length > 0) return; // já rodou hoje

  console.log(`[backup] Iniciando backup diário (${hoje})...`);
  const resumo: Record<string, number> = {};

  for (const tabela of TABELAS_BACKUP) {
    const linhas = await buscarTabelaCompleta(tabela);
    resumo[tabela] = linhas.length;
    const conteudo = JSON.stringify(linhas);
    const { error } = await supabase.storage
      .from(BUCKET_BACKUP)
      .upload(`${hoje}/${tabela}.json`, Buffer.from(conteudo), {
        contentType: "application/json",
        upsert: true,
      });
    if (error) console.error(`[backup] Erro ao salvar ${tabela}:`, error.message);
  }

  await supabase.storage
    .from(BUCKET_BACKUP)
    .upload(`${hoje}/manifesto.json`, Buffer.from(JSON.stringify({ data: hoje, tabelas: resumo })), {
      contentType: "application/json",
      upsert: true,
    });

  console.log("[backup] Backup concluído:", resumo);
  await limparBackupsAntigos();
}

async function limparBackupsAntigos() {
  const { data: pastas } = await supabase.storage.from(BUCKET_BACKUP).list("");
  if (!pastas) return;

  const limite = new Date();
  limite.setDate(limite.getDate() - RETENCAO_DIAS);

  for (const pasta of pastas) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pasta.name)) continue;
    const dataPasta = new Date(pasta.name);
    if (dataPasta < limite) {
      const { data: arquivos } = await supabase.storage.from(BUCKET_BACKUP).list(pasta.name);
      if (arquivos && arquivos.length > 0) {
        await supabase.storage.from(BUCKET_BACKUP).remove(arquivos.map((a) => `${pasta.name}/${a.name}`));
        console.log(`[backup] Removido backup antigo: ${pasta.name}`);
      }
    }
  }
}
