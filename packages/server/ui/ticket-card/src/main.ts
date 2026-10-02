import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import './style.css';
import { TICKET_STATUS_LABEL } from '../../../../../config.js';

/** The structured output of create_support_case. */
interface Ticket {
  ticket_ref: string;
  already_existed: boolean;
  simulated: boolean;
  symptom: string | null;
  product: { product_id: string; model: string };
  steps_tried: string[];
  warranty: { status: 'in_warranty' | 'expired' | 'unknown'; term_months: number; end_date?: string; purchase_date?: string };
  warnings: string[];
  next_steps: string;
}

const root = document.getElementById('card')!;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // text only, never markup, whatever the ticket contains
  return node;
}

function render(ticket: Ticket): void {
  const head = element('div', 'head');
  head.append(element('p', 'title', ticket.already_existed ? 'Support ticket (already filed)' : 'Support ticket'), element('span', 'pill', ticket.simulated ? 'Simulated' : 'Filed'));

  const rows = element('dl');
  const add = (label: string, value: Node | string) => {
    rows.append(element('dt', undefined, label));
    const dd = element('dd');
    dd.append(value);
    rows.append(dd);
  };
  if (ticket.symptom) add('Problem', ticket.symptom);

  const status = element('span', `status status--${ticket.warranty.status}`, TICKET_STATUS_LABEL[ticket.warranty.status]);
  const warranty = element('span');
  warranty.append(status, ticket.warranty.end_date ? ` until ${ticket.warranty.end_date}` : '');
  add('Warranty', warranty);

  if (ticket.steps_tried.length > 0) {
    const list = element('ul');
    for (const step of ticket.steps_tried) list.append(element('li', undefined, step));
    add('Tried', list);
  } else {
    add('Tried', 'Nothing recorded');
  }

  const children: Node[] = [head, element('p', 'ref', ticket.ticket_ref), element('p', 'product', ticket.product.model), rows];
  for (const warning of ticket.warnings) children.push(element('p', 'warn', warning));
  children.push(element('p', 'next', ticket.next_steps));
  root.replaceChildren(...children);
}

function applyHost(context: McpUiHostContext): void {
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}

const app = new App({ name: 'Support ticket', version: '1.0.0' });

// Every handler is registered before connecting, so nothing the host sends first is missed.
app.ontoolresult = (result) => {
  const ticket = result.structuredContent as Ticket | undefined;
  if (ticket?.ticket_ref) render(ticket);
  else root.replaceChildren(element('p', 'muted', 'The ticket could not be shown.'));
};
app.ontoolcancelled = (params) => root.replaceChildren(element('p', 'muted', `The ticket was not filed: ${params.reason ?? 'cancelled'}`));
app.onhostcontextchanged = applyHost;
app.onteardown = async () => ({});
app.onerror = console.error;

app.connect().then(() => {
  const context = app.getHostContext();
  if (context) applyHost(context);
});
