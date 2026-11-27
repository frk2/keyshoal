// This function is serialized by Chrome and runs in the isolated top-frame world.
export function fillExactOrigin(origin, login) {
  if (window !== window.top || location.protocol !== 'https:' || location.origin !== origin) return false;
  const visible = field => {
    if (field.matches(':disabled') || field.readOnly || field.hidden || field.closest('[inert]')) return false;
    const { visibility, display, opacity } = getComputedStyle(field);
    return visibility === 'visible' && display !== 'none' && opacity !== '0' && field.getClientRects().length > 0;
  };
  const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
  const marked = passwords.filter(field => field.autocomplete.toLowerCase().split(/\s+/).includes('current-password'));
  const target = marked.length === 1 ? marked[0] :
    marked.length === 0 && passwords.length === 1 && !passwords[0].autocomplete.toLowerCase()
      .split(/\s+/).some(value => ['new-password', 'one-time-code'].includes(value)) ? passwords[0] : null;
  if (!target) return false;
  const form = target.form;
  if (!form || form.querySelector('input[autocomplete~="new-password" i]')) return false;
  const external = value => {
    try { return new URL(value || location.href, document.baseURI).origin !== origin; }
    catch { return true; }
  };
  const submitters = [...form.elements].filter(element => element.hasAttribute('formaction') && !element.disabled);
  if (external(form.getAttribute('action')) || submitters.some(element => external(element.getAttribute('formaction')))) return false;
  const fields = [...form.elements].filter(field => field instanceof HTMLInputElement &&
    ['text', 'email', 'tel'].includes(field.type) && visible(field));
  const named = fields.filter(field => field.autocomplete.toLowerCase().split(/\s+/).includes('username'));
  const previous = fields.filter(field => (field.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING));
  const username = named.length === 1 ? named[0] : named.length === 0 && previous.length === 1 ? previous[0] : null;
  const set = (field, value) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, value);
  if (username) set(username, login.username);
  set(target, login.password);
  // Set both fields before dispatching events that the page can handle synchronously.
  for (const field of [username, target]) {
    if (!field) continue;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
}
