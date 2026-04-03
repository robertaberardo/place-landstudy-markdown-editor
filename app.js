'use strict';

/* ============================================================
   Utilities
   ============================================================ */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ============================================================
   Value Tokenizer
   Parses inline syntax within a value string:
     [?tooltip text]   → tooltip icon rendered on the label
     =text             → editable value (blue bg)
   ============================================================ */
function tokenizeValue(str) {
  const tokens = [];
  const tooltips = [];
  /* ANNOTATION — let hint = null; */
  let buf = '';
  let i = 0;

  const highlight = str.startsWith('=');
  const dropdown = !highlight && str.startsWith('>');
  const src = (highlight || dropdown) ? str.slice(1) : str;

  while (i < src.length) {
    if (src[i] === '[') {
      const ttMatch = src.slice(i).match(/^\[\?([^\]]+)\]/);
      if (ttMatch) {
        if (buf) { tokens.push({ type: 'text', text: buf }); buf = ''; }
        tooltips.push(ttMatch[1]);
        i += ttMatch[0].length;
        if (src[i] === ' ') i++;
        continue;
      }
      /* ANNOTATION —
      const hintMatch = src.slice(i).match(/^\[!([^\]]+)\]/);
      if (hintMatch) {
        if (buf) { tokens.push({ type: 'text', text: buf }); buf = ''; }
        hint = hintMatch[1].trim();
        i += hintMatch[0].length;
        if (src[i] === ' ') i++;
        continue;
      }
      */
    }
    buf += src[i];
    i++;
  }

  if (buf) tokens.push({ type: 'text', text: buf.trimEnd() });
  return { highlight, dropdown, tokens, tooltips /*, hint — ANNOTATION */ };
}

function renderTokens(parsed) {
  const inner = parsed.tokens.map(t => {
    if (t.type === 'text') return esc(t.text);
    return '';
  }).join('');

  if (parsed.highlight) return `<span class="value-highlight">${inner}</span>`;
  if (parsed.dropdown)  return `<span class="value-dropdown">${inner}<i class="value-dropdown-chevron">^</i></span>`;
  return inner;
}

function renderLabel(text, tooltips) {
  const icons = tooltips.map(tip =>
    `<span class="tt" data-tip="${esc(tip)}"><i class="tt-icon">?</i></span>`
  ).join('');
  return `${esc(text)}${icons ? '\u00a0' + icons : ''}`;
}

/* ============================================================
   Markdown Parser  →  AST (array of nodes)

   Supported syntax:
   ─────────────────────────────────────────────────────────
   <!-- comment -->           ignored, never rendered
   # Title                    page title
   ## Section                 section header
   ### Subsection             subsection header
   ---                        horizontal divider
   Label: Value               simple field row
   Label: =Value              highlighted value
   Label: text [?tip]         field + tooltip
   Label: [badge:X]           field + badge(s)
   Label:                     multi-value field (sub-fields indented 2 spaces)
     Sub: Value
     Sub: Value
   Label::                    table field (rows indented 2 spaces)
     | Range | Value |
   @allowed: t1, t2           green tag row (Usos permitidos)
   @forbidden: t1, t2         red tag row (Usos proibidos)
   @note: inline text         single-line note block
   @note:                     multi-line note (indented body)
     Text...
   @button: Label             action button
   ============================================================ */
function parseMarkdown(md) {
  // Strip HTML comments at string level before line parsing,
  // so <!-- --> inside comment text can't prematurely end the block.
  const stripped = md.replace(/<!--[\s\S]*?-->/g, '');
  const lines = stripped.split('\n');
  const nodes = [];
  let i = 0;

  function peek() { return i < lines.length ? lines[i] : null; }
  function consume() { return lines[i++]; }

  // Collect indented block (2-space or tab indent)
  function collectIndented() {
    const collected = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.startsWith('  ') || l.startsWith('\t')) {
        collected.push(l.replace(/^  |\t/, ''));
        i++;
      } else if (l.trim() === '' && i + 1 < lines.length &&
                 (lines[i + 1].startsWith('  ') || lines[i + 1].startsWith('\t'))) {
        collected.push('');
        i++;
      } else {
        break;
      }
    }
    return collected;
  }

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Empty
    if (!trimmed) { i++; continue; }

    // H1
    if (trimmed.startsWith('# ')) {
      nodes.push({ type: 'title', text: trimmed.slice(2).trim() });
      i++; continue;
    }

    // H2
    if (trimmed.startsWith('## ')) {
      nodes.push({ type: 'section', text: trimmed.slice(3).trim() });
      i++; continue;
    }

    // H3
    if (trimmed.startsWith('### ')) {
      nodes.push({ type: 'subsection', text: trimmed.slice(4).trim() });
      i++; continue;
    }

    // Divider
    if (trimmed === '---') {
      nodes.push({ type: 'divider' });
      i++; continue;
    }

    // Directives: @keyword: value
    if (trimmed.startsWith('@')) {
      const dm = trimmed.match(/^@([\w-]+)(?::\s*(.*))?$/);
      if (dm) {
        const dir = dm[1];
        const val = (dm[2] || '').trim();

        if (dir === 'button') {
          nodes.push({ type: 'button', text: val });
          i++; continue;
        }
        if (dir === 'note') {
          i++;
          if (val) {
            nodes.push({ type: 'note', content: val });
          } else {
            const body = collectIndented();
            nodes.push({ type: 'note', content: body.join('\n').trim() });
          }
          continue;
        }
        if (dir === 'desc') {
          i++;
          if (val) {
            nodes.push({ type: 'desc', content: val });
          } else {
            const body = collectIndented();
            nodes.push({ type: 'desc', content: body.join('\n').trim() });
          }
          continue;
        }
      }
      i++; continue;
    }

    // Table field: "Label::" (double colon, optional hint)
    const tblM = line.match(/^([^:]+)::\s*(.*)?$/);
    if (tblM && !tblM[1].includes(':')) {
      const label = tblM[1].trim();
      /* ANNOTATION — const tblHint = tblM[2] ? tokenizeValue(tblM[2].trim()).hint : null; */
      i++;
      const indented = collectIndented();
      const rows = indented
        .filter(l => l.trim().startsWith('|'))
        .map(l => {
          const cells = l.trim().split('|').map(c => c.trim()).filter(Boolean);
          return { cells };
        });
      nodes.push({ type: 'field-table', label /*, hint: tblHint — ANNOTATION */, rows });
      continue;
    }

    // Regular field: "Label: Value" or "Label:" (with indented sub-fields)
    const fieldM = line.match(/^([^:]+):\s*(.*)$/);
    if (fieldM) {
      const label = fieldM[1].trim();
      const rawVal = fieldM[2].trim();

      const parsedRaw = tokenizeValue(rawVal);
      // ANNOTATION — also strip [!...]: .replace(/\[![^\]]+\]/g, '')
      const realVal = rawVal.replace(/\[\?[^\]]+\]/g, '').replace(/\[![^\]]+\]/g, '').trim();

      // No real value → check for indented sub-fields
      if (!realVal && i + 1 < lines.length &&
          (lines[i + 1].startsWith('  ') || lines[i + 1].startsWith('\t'))) {
        i++;
        const indented = collectIndented();
        // Decide: table rows or sub-fields?
        if (indented.some(l => l.trim().startsWith('|'))) {
          const rows = indented
            .filter(l => l.trim().startsWith('|'))
            .map(l => {
              const cells = l.trim().split('|').map(c => c.trim()).filter(Boolean);
              return { cells };
            });
          nodes.push({ type: 'field-table', label, tooltips: parsedRaw.tooltips /*, hint: parsedRaw.hint — ANNOTATION */, rows });
        } else {
          const subFields = indented
            .filter(l => l.trim())
            .map(l => {
              const sm = l.match(/^([^:]+):\s*(.*)$/);
              return sm
                ? { label: sm[1].trim(), value: tokenizeValue(sm[2].trim()) }
                : { label: null, value: tokenizeValue(l.trim()) };
            });
          nodes.push({ type: 'field-multi', label, tooltips: parsedRaw.tooltips /*, hint: parsedRaw.hint — ANNOTATION */, subFields });
        }
        continue;
      }

      nodes.push({ type: 'field', label /*, hint: parsedRaw.hint — ANNOTATION */, value: parsedRaw });
      i++; continue;
    }

    // Fallback: plain text
    nodes.push({ type: 'text', content: trimmed });
    i++;
  }

  return nodes;
}

/* ============================================================
   Renderer  →  HTML string
   ============================================================ */
function renderNodes(nodes) {
  return nodes.map(node => {
    switch (node.type) {

      case 'title':
        return `<h1 class="page-title">${esc(node.text)}</h1>`;

      case 'section':
        return `<div class="section-header">${esc(node.text)}</div>`;

      case 'subsection':
        return `<div class="subsection-header">${esc(node.text)}</div>`;

      case 'divider':
        return `<hr class="divider">`;

      case 'field': {
        /* ANNOTATION — const hintAttr = node.hint ? ` data-hint="${esc(node.hint)}"` : ''; */
        return `<div class="field-row">
          <span class="field-label">${renderLabel(node.label, node.value.tooltips)}</span>
          <span class="field-value">${renderTokens(node.value)}</span>
        </div>`;
      }

      case 'field-multi': {
        /* ANNOTATION — const hintAttr = node.hint ? ` data-hint="${esc(node.hint)}"` : ''; */
        return `<div class="field-row field-row--multi">
          <span class="field-label">${renderLabel(node.label, node.tooltips || [])}</span>
          <span class="field-value">
            ${node.subFields.map(sf => sf.label === null ? `
              <span class="sub-field sub-field--value-only">
                <span class="sub-value">${renderTokens(sf.value)}</span>
              </span>` : `
              <span class="sub-field">
                <span class="sub-label">${renderLabel(sf.label, sf.value.tooltips)}</span>
                <span class="sub-value">${renderTokens(sf.value)}</span>
              </span>`).join('')}
          </span>
        </div>`;
      }

      case 'field-table': {
        /* ANNOTATION — const hintAttr = node.hint ? ` data-hint="${esc(node.hint)}"` : ''; */
        return `<div class="field-row field-row--table">
          <span class="field-label">${renderLabel(node.label, node.tooltips || [])}</span>
          <span class="field-value">
            <table class="field-tbl">
              ${node.rows.map(r => `
                <tr>
                  <td class="ft-label">${esc(r.cells[0] || '')}</td>
                  ${r.cells.slice(1).map(c => `<td class="ft-value">${esc(c)}</td>`).join('')}
                </tr>`).join('')}
            </table>
          </span>
        </div>`;
      }

      case 'note':
        return `<div class="note-block">${node.content.split('\n').map(esc).join('<br>')}</div>`;

      case 'desc':
        return `<div class="desc-block">${node.content.split('\n').map(esc).join('<br>')}</div>`;

      case 'button':
        return `<button class="action-btn">${esc(node.text)}</button>`;


      case 'text':
        return `<p class="text-line">${esc(node.content)}</p>`;

      default:
        return '';
    }
  }).join('\n');
}

/* ============================================================
   Embedded Template
   ============================================================ */
const TEMPLATE = `<!-- Consulta do Lote — use o botão Sintaxe na barra superior para ver a referência de sintaxe -->


# Legislação

Numeração predial:
  | 12 | Área | 0 m |
  | 12 | Área | 10 m |


Inscrição Imobiliária do lote:
  XXXX
  XXXX
Código do lote: XXX-XXX-XXXX
Área do lote: XXX,XX m² [?Área total do terreno conforme matrícula no cartório de registro de imóveis]
Zona de construção: >ZEU [?Zona de Estruturação Urbana — permite maior adensamento e usos mistos]
Subzona: >321

Coeficiente de aproveitamento: [?Multiplica a área do lote para definir a área máxima construível]
  Básico: 1,00
  Com Outorga Onerosa: 4,00

Taxa de contribuição: 0,35
Taxa de Anualidade de Base: 0,05
Taxa de Ocupação de Torre: 70%
Taxa de permeabilidade: 5% [?Área mínima do lote que deve ser permeável para absorção de águas pluviais]
Largura da via em frente ao lote: XXX m
Altura máxima: XXX m [?Gabarito máximo permitido pelo zoneamento, medido a partir do nível do passeio]
Altura máxima de Embasamento: XXX m

Recuo do Embasamento Frontal:
  Com fachadas ativas: 4 m [?Fachadas com uso comercial no térreo podem ter recuo reduzido]
  Residências unifamiliares: 4 m
  Demais casos: 6 m

Recuo do Embasamento Lateral e Fundos:
  Quando não estiverem para vizinhos: 0 m
  Para vizinhos: 0 m

Recuos Unifamiliares:
  com abertura: 1,5 m [?Abertura como janela exige afastamento mínimo de 1,5 m da divisa]
  sem abertura: 0 m

Recuo frontal torre: XXX m

Recuo lateral e fundos torre::
  | Até altura de | 0 m |
  | 0 a 4 pavimentos | 0 m |
  | 2 a 4 pavimentos | 2 m |
  | 5 a 8 pavimentos | 2,5 m |
  | 9 a 10 pavimentos | 3 m |
  | 11 a 20 pavimentos | 3,5 m |
  | 21 a 27 pavimentos | 4,7 m |
  | mais de 20 pavimentos | 5,5 m |

Lote mínimo:
  Área mínima: XXX m²
  Dimensões mínima da testada: XXX m [?Largura mínima da frente do lote voltada para a via pública]
  Profundidade mínima: XX m

# Observações

@note:
  O lote está localizado em área de restrição ambiental, portanto é necessário considerar
  as normas específicas de proteção ao meio ambiente durante o processo de aprovação junto
  à Prefeitura. Consulte os órgãos ambientais antes de apresentar o projeto.

@note:
  O lote está avaliado em área prevista para Intervenções Viárias conforme diretrizes do
  Plano Diretor e do Plano de Mobilidade Municipal. Verifique junto à Subprefeitura a
  situação do alinhamento predial e possíveis restrições ao uso do solo.

@note:
  O lote está situado em área com avaliação especial pelo órgão de patrimônio histórico.
  Recomenda-se consulta prévia antes de protocolar pedido de aprovação de projeto.

# Simulação de áreas

Coeficiente de aproveitamento utilizado: =4,00
Área computável: XXX m² [?Área que conta para o cálculo do coeficiente de aproveitamento]
Área de incentivos: 20 m²
Áreas privativas: XXX m²
Área não computável: XXX
Área privativa estimada: XXXX m²
Área Privativa / Área do terreno: 5,22
Área do computável: XXX
Eficiência: 0,85 [?Relação entre área privativa e área construída total]
Área total construída: XXXX m²

# Viabilidade financeiras

@desc:
  Nessa seção é possível simular uma viabilidade financeira prévia para o empreendimento.
  Edite as informações necessárias nos campos coloridos para obter os resultados de viabilidade.
  Os resultados atingidos são estimados e de responsabilidade do usuário, a prefeitura não se
  responsabiliza ou compromete com nenhum valor. A ferramenta de viabilidade financeira
  é auxiliar para o empreendedor.

## Custos do terreno

Pagamento em parcelas financeiras: 0,00% VGV
Pagamento em dinheiro: R$ XXX

## Contrapartidas Outorgas

Contrapartidas Financeiras (CF): R$ XXX [?Valor total a pagar à Prefeitura pelo uso do potencial construtivo adicional]
Fator de Contribuição (FC): XXX %
Adicional Construtivo (AC): XXX m²
Adicional DP/SB: R$ XXX
Área útil (AU): 0
Número de unidades habitacionais: R$ XXX XXX
CUB: R$ XXX [?Custo Unitário Básico da construção civil — referência para cálculo de obra]
FT: 0,85

## Receitas

Valor das unidades privadas: R$ XXX
com um valor de m² privativo: R$ XXX
Receita bruta: R$ XXXXX
Permuta do terreno: XXX % VGV [?Percentual do VGV entregue ao proprietário do terreno como pagamento]
Imposto: XXX % VGV

## Despesas

Compra do terreno: R$ XXX
Custo da Obra (R$ por m² construído): R$ XXX
Total da obra estimado: R$ XXX.XXX.XXX,XX
Custo de outorgas internas: XXX
Marketing: XXX
Custos extras: XXX %
Total custos: R$ XXX.XXX.XXX,XX

## Indicadores de viabilidade

ROI: 37%
VGV: R$ XXX.XXX.XXX,XX
Resultado: R$ XXX.XXX.XXX,XX


## Resultado da simulação volumétrica

Altura do edifício simulado: XXXX,XX m
Altura máxima alcançável: XXXX,XX m
Número máximo de pavimentos: XXXX
Recuos utilizados: XXXX m
Área por pavimento (base): XXXX m²
Área por pavimento (corpo): XXXX m² [?Área do pavimento tipo na torre, após aplicação dos recuos obrigatórios]
Relação da área total simulada: 0 %
Taxa de ocupação da torre na simulação: 75%

@button: Gerar Envelope

`;

/* ============================================================
   Notion URL / ID helpers
   ============================================================ */
function formatNotionUUID(hex) {
  const h = hex.replace(/-/g, '');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

// Accepts a full Notion URL or a raw block ID (with or without dashes).
// Priority: URL hash (#blockId) → URL path slug → plain ID.
function extractNotionId(input) {
  try {
    const url = new URL(input);
    const hash = url.hash.replace('#', '').replace(/-/g, '');
    if (/^[0-9a-f]{32}$/i.test(hash)) return formatNotionUUID(hash);
    const slug = url.pathname.split('/').pop();
    const pathId = slug.replace(/^.*-/, '').replace(/-/g, '');
    if (/^[0-9a-f]{32}$/i.test(pathId)) return formatNotionUUID(pathId);
  } catch {}
  const clean = input.replace(/-/g, '');
  if (/^[0-9a-f]{32}$/i.test(clean)) return formatNotionUUID(clean);
  return input;
}

/* ============================================================
   Syntax reference (plain text for clipboard copy)
   ============================================================ */
const SYNTAX_TEXT = `SINTAXE — Lote Editor

COMENTÁRIOS
  <!-- qualquer texto -->       nunca aparece no preview

TÍTULOS
  # Título                      título principal da página
  ## Seção                      cabeçalho de seção
  ### Subseção                  cabeçalho de subseção

CAMPOS
  Label: Valor                  campo simples
  Label: =Valor                 valor editável (fundo azul)
  Label: >Valor                 valor em destaque — pill escuro com chevron
  Label: Valor [?dica]          tooltip aparece no label ao passar o mouse
  Label:                        campo com múltiplos sub-itens (indentados 2 espaços)
    Sub-label: Valor
    Sub-label: Valor [?dica]
    Valor                       valor sem sub-label (só o valor, alinhado à direita)
  Label::                       campo com tabela progressiva (indentada 2 espaços)
    | Faixa          | Valor |           (2 colunas)
    | Faixa          | Min  | Max |      (3 colunas)


BLOCOS ESPECIAIS
  @desc:                        descrição fixa abaixo de um cabeçalho de seção
    Texto do bloco...
  @note:                        bloco de observação (borda lateral cinza)
    Texto da nota...
  @button: Texto                botão de ação

SEPARADOR
  ---                           linha divisória
`;

/* ============================================================
   ANNOTATION — Status Column (commented out)
   Aligns hint labels to their field rows via [!text] syntax.
   Re-enable by uncommenting this block and all ANNOTATION markers.
   ============================================================
function updateAnnotationCol() {
  const col = document.getElementById('annotation-col');
  const card = document.getElementById('preview');
  if (!col || !card) return;
  col.innerHTML = '';
  card.querySelectorAll('.field-row').forEach(row => {
    const item = document.createElement('div');
    item.className = 'annotation-item';
    item.style.top    = row.offsetTop + 'px';
    item.style.height = row.offsetHeight + 'px';
    const hint = row.dataset.hint;
    if (hint === '!') {
      item.classList.add('annotation-item--transparent');
    } else if (hint === 'hide') {
      // default gray — acknowledged, no text needed
    } else if (hint) {
      item.textContent = hint;
    } else {
      item.classList.add('annotation-item--missing');
    }
    col.appendChild(item);
  });
}
============================================================ */

/* ============================================================
   Shared Toolbar Setup (help panel + copy syntax + copy image)
   Works for both index.html and notion.html
   ============================================================ */
function setupToolbar(preview) {
  const helpPanel     = document.getElementById('help-panel');
  const btnHelp       = document.getElementById('btn-help');
  const btnHelpClose  = document.getElementById('btn-help-close');
  const btnCopySyntax = document.getElementById('btn-copy-syntax');
  const btnCopyImage  = document.getElementById('btn-copy-image');

  if (btnHelp && helpPanel) {
    btnHelp.addEventListener('click', () => {
      const open = helpPanel.classList.toggle('open');
      btnHelp.classList.toggle('active', open);
    });
  }
  if (btnHelpClose && helpPanel) {
    btnHelpClose.addEventListener('click', () => {
      helpPanel.classList.remove('open');
      if (btnHelp) btnHelp.classList.remove('active');
    });
  }
  if (btnCopySyntax) {
    btnCopySyntax.addEventListener('click', () => {
      navigator.clipboard.writeText(SYNTAX_TEXT).then(() => {
        btnCopySyntax.classList.add('copied');
        setTimeout(() => btnCopySyntax.classList.remove('copied'), 1800);
      });
    });
  }
  if (btnCopyImage) {
    btnCopyImage.addEventListener('click', async () => {
      btnCopyImage.disabled = true;
      try {
        const canvas = await html2canvas(preview, {
          backgroundColor: '#ffffff',
          scale: 2,
          useCORS: true,
          logging: false
        });
        canvas.toBlob(async blob => {
          try {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            btnCopyImage.classList.add('copied');
            setTimeout(() => btnCopyImage.classList.remove('copied'), 1800);
          } catch {
            const url = URL.createObjectURL(blob);
            const a = Object.assign(document.createElement('a'), { href: url, download: 'preview.png' });
            a.click();
            URL.revokeObjectURL(url);
          }
          btnCopyImage.disabled = false;
        }, 'image/png');
      } catch {
        btnCopyImage.disabled = false;
      }
    });
  }
}

/* ============================================================
   Floating Tooltip
   ============================================================ */
function setupTooltip(container) {
  const ttFloat = document.createElement('div');
  ttFloat.id = 'tt-float';
  document.body.appendChild(ttFloat);

  function positionTip(el) {
    const r = el.getBoundingClientRect();
    const tw = ttFloat.offsetWidth;
    let left = r.left;
    if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
    ttFloat.style.left = left + 'px';
    ttFloat.style.top  = (r.top - ttFloat.offsetHeight - 8) + 'px';
  }

  container.addEventListener('mouseover', e => {
    const target = e.target.closest('.tt');
    if (!target) return;
    const tip = target.dataset.tip;
    if (!tip) return;
    ttFloat.textContent = tip;
    ttFloat.style.opacity = '1';
    positionTip(target);
  });

  container.addEventListener('mouseout', e => {
    if (!e.target.closest('.tt')) return;
    ttFloat.style.opacity = '0';
  });

  container.addEventListener('mousemove', e => {
    const target = e.target.closest('.tt');
    if (target) positionTip(target);
  });
}

/* ============================================================
   App Init
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  // Notion view — preview only
  if (!document.getElementById('editor')) {
    const params    = new URLSearchParams(window.location.search);
    const raw_block = params.get('block_id') || window.location.hash.replace('#', '') || null;
    const block_id  = raw_block ? extractNotionId(raw_block) : null;

    console.log('notion params:', { raw_block, block_id });

    const preview = document.getElementById('preview');

    if (block_id) {
      const LAMBDA = 'https://l6oxqr6uymxlu45wfl34z6bog40nxody.lambda-url.us-east-1.on.aws/';

      function syncFromNotion() {
        fetch(`${LAMBDA}?block_id=${block_id}`)
          .then(r => r.json())
          .then(data => {
            const content = data[data.type];
            const richText = content && content.rich_text ? content.rich_text : [];
            const markdown = richText.map(rt => rt.plain_text).join('');
            if (preview && markdown) {
            preview.innerHTML = renderNodes(parseMarkdown(markdown));
            /* ANNOTATION — requestAnimationFrame(updateAnnotationCol); */
          }
          })
          .catch(err => console.error('notion fetch error:', err));
      }

      setupTooltip(preview);
      syncFromNotion();
      setInterval(syncFromNotion, 2000);
    } else {
      console.warn('notion: missing block_id in URL params');
      const warningEl = document.getElementById('notion-warning');
      if (warningEl) warningEl.classList.add('visible');
      if (preview) {
        preview.innerHTML = renderNodes(parseMarkdown(TEMPLATE));
        /* ANNOTATION — requestAnimationFrame(updateAnnotationCol); */
      }
      setupTooltip(preview);
    }

    setupToolbar(preview);
    return;
  }

  const editor   = document.getElementById('editor');
  const preview  = document.getElementById('preview');
  const fileInput = document.getElementById('file-input');
  const btnLoad  = document.getElementById('btn-load');
  const btnSave  = document.getElementById('btn-save');
  const resizer  = document.getElementById('resizer');
  const panels   = document.querySelector('.panels');

  // ── Toolbar (help panel + copy syntax + copy image) ───────
  setupToolbar(preview);

  // ── Load template ──────────────────────────────────────────
  editor.value = TEMPLATE;
  render();

  // ── Floating tooltip ───────────────────────────────────────
  setupTooltip(preview);

  // ── Live preview ───────────────────────────────────────────
  let debounce;
  editor.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(render, 120);
  });

  // ── Tab key → 2 spaces ────────────────────────────────────
  editor.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(end);
      editor.selectionStart = editor.selectionEnd = s + 2;
      render();
    }
  });

  // ── Load .md file ──────────────────────────────────────────
  btnLoad.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { editor.value = ev.target.result; render(); };
    reader.readAsText(file, 'UTF-8');
    fileInput.value = '';
  });

  // ── Save .md file ──────────────────────────────────────────
  btnSave.addEventListener('click', () => {
    const blob = new Blob([editor.value], { type: 'text/markdown;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: 'consulta-lote.md' });
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── Resizable split pane ───────────────────────────────────
  let resizing = false;

  resizer.addEventListener('mousedown', () => {
    resizing = true;
    resizer.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!resizing) return;
    const rect = panels.getBoundingClientRect();
    const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0.2), 0.8);
    document.querySelector('.panel-editor').style.flex = `0 0 ${ratio * 100}%`;
    document.querySelector('.panel-preview').style.flex = `0 0 ${(1 - ratio) * 100 - 0.3}%`;
  });

  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    resizer.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  // ── Render ─────────────────────────────────────────────────
  function render() {
    try {
      const nodes = parseMarkdown(editor.value);
      preview.innerHTML = renderNodes(nodes);
    } catch (err) {
      preview.innerHTML = `<div class="parse-error">Erro: ${esc(err.message)}</div>`;
    }
    /* ANNOTATION — requestAnimationFrame(updateAnnotationCol); */
  }
});
