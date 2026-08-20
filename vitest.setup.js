/**
 * O ambiente antes de qualquer import.
 *
 * `server/tokens.js` lê o SESSION_SECRET na primeira assinatura e o guarda; e
 * `server/index.js` decide no corpo do módulo se sobe o painel, se exige
 * segredo e em que porta escuta. Definir isto dentro de um teste chega tarde:
 * o módulo já foi avaliado. Daí um arquivo de preparação, que o Vitest roda
 * antes de importar o teste.
 */
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ??= 'segredo-de-teste-com-mais-de-trinta-e-dois-caracteres';
// Porta 0: o sistema escolhe uma livre, e dois arquivos de teste rodando ao
// mesmo tempo não brigam por ela.
process.env.PORT ??= '0';
