import { supabase } from "./supabase";

// Move leads parados demais para "perdido" sozinho — roda no máximo uma vez por dia.
export async function processarGatilhoInatividade() {
  const { data: config, error: erroConfig } = await supabase
    .from("config_automacao")
    .select("*")
    .eq("id", 1)
    .single();

  if (erroConfig || !config || !config.gatilho_inatividade_ativo) return;

  const hoje = new Date().toISOString().slice(0, 10);
  if (config.ultima_execucao && config.ultima_execucao.slice(0, 10) === hoje) return;

  const limite = new Date();
  limite.setDate(limite.getDate() - config.gatilho_inatividade_dias);

  const { data: leadsInativos, error: erroLeads } = await supabase
    .from("leads")
    .select("id")
    .in("etapa", ["contato", "visita", "proposta", "negociacao"])
    .lt("atualizado_em", limite.toISOString());

  if (erroLeads) {
    console.error("[automacao] Erro ao buscar leads inativos:", erroLeads.message);
    return;
  }

  if (leadsInativos && leadsInativos.length > 0) {
    const { error: erroUpdate } = await supabase
      .from("leads")
      .update({
        etapa: "perdido",
        motivo_perda_id: config.gatilho_inatividade_motivo_id,
        motivo_perda_obs: `Movido automaticamente por inatividade (${config.gatilho_inatividade_dias} dias sem atualização).`,
      })
      .in(
        "id",
        leadsInativos.map((l) => l.id)
      );

    if (erroUpdate) {
      console.error("[automacao] Erro ao mover leads inativos:", erroUpdate.message);
    } else {
      console.log(`[automacao] ${leadsInativos.length} lead(s) movido(s) para perdido por inatividade.`);
    }
  }

  await supabase.from("config_automacao").update({ ultima_execucao: new Date().toISOString() }).eq("id", 1);
}
