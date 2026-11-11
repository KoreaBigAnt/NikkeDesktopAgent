const form = document.getElementById('persona-form');
const personality = document.getElementById('personality');
const systemPrompt = document.getElementById('system-prompt');
const save = document.getElementById('persona-save');
const errorText = document.getElementById('persona-error');

document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'white'
  ? 'white' : 'black';

function showError(error) {
  errorText.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  errorText.hidden = false;
}

window.pet.persona().then(persona => {
  personality.value = persona.personality;
  systemPrompt.value = persona.systemPrompt;
  save.disabled = false;
}).catch(showError);

form.addEventListener('submit', async event => {
  event.preventDefault();
  save.disabled = true;
  errorText.hidden = true;
  try {
    await window.pet.savePersona({ personality: personality.value, systemPrompt: systemPrompt.value });
    window.close();
  } catch (error) {
    showError(error);
    save.disabled = false;
  }
});

document.getElementById('persona-cancel').addEventListener('click', () => window.close());
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') window.close();
});
