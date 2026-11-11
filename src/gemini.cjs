const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const { Readable } = require('node:stream');

const modelUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite';
const defaultPrompt = '너는 데스크톱 펫의 대화 상대야. 사용자의 말투와 언어에 맞춰 친근하고 자연스럽게 대화해. 일상적인 인사나 잡담에는 짧게 답해.';

async function request(url, key, options) {
  let response;
  try {
    response = await fetch(url, {
      ...options, redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw new Error('Google Gemini 서버에 연결할 수 없습니다.');
  }
  if (response.ok) return response;
  await response.body?.cancel();
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new Error('Google AI Studio에서 Gemini 키와 프로젝트의 API 사용 권한을 확인해 주세요.');
  }
  if (response.status === 429) throw new Error('Gemini API 사용 한도에 도달했습니다. Google AI Studio에서 한도를 확인해 주세요.');
  throw new Error(`Gemini 요청이 실패했습니다. (HTTP ${response.status})`);
}

class Gemini {
  history = [];
  active = null;

  static async validateKey(key) {
    const response = await request(modelUrl, key, { signal: AbortSignal.timeout(10000) });
    await response.body?.cancel();
  }

  async chat(key, text, emit, { personality, systemPrompt } = {}) {
    const controller = new AbortController();
    this.active = controller;
    const timeout = AbortSignal.timeout(90000);
    const signal = AbortSignal.any([controller.signal, timeout]);
    const itemId = randomUUID();
    const user = { role: 'user', parts: [{ text }] };
    let answer = '';
    const instructions = [{ text: systemPrompt || defaultPrompt }];
    if (personality) instructions.push({ text: '캐릭터 성격\n' + personality });
    try {
      const response = await request(modelUrl + ':streamGenerateContent?alt=sse', key, {
        method: 'POST', signal,
        body: JSON.stringify({
          systemInstruction: { parts: instructions },
          contents: [...this.history, user],
          generationConfig: { maxOutputTokens: 768 },
        }),
      });
      const lines = createInterface({ input: Readable.fromWeb(response.body), crlfDelay: Infinity });
      let data = [];
      const emitData = () => {
        if (!data.length) return;
        const message = JSON.parse(data.join('\n'));
        data = [];
        if (message.error) throw new Error('Gemini가 답변을 생성하는 중 오류가 발생했습니다.');
        const parts = message.candidates?.[0]?.content?.parts ?? [];
        const chunk = parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
        if (chunk) {
          answer += chunk;
          emit('delta', { itemId, text: chunk });
        }
      };
      for await (const line of lines) {
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        if (!line) emitData();
      }
      emitData();
      if (!answer.trim()) throw new Error('Gemini에서 표시할 답변을 받지 못했습니다.');
      this.history = [...this.history, user, { role: 'model', parts: [{ text: answer }] }].slice(-20);
      emit('done', { status: 'completed' });
    } catch (error) {
      if (controller.signal.aborted) emit('done', { status: 'interrupted' });
      else emit('done', { status: 'failed', error: timeout.aborted ? 'Gemini 응답 시간이 초과되었습니다.' : error.message });
    } finally {
      this.active = null;
    }
  }

  stop() {
    this.active?.abort();
  }
}

module.exports = { Gemini };
