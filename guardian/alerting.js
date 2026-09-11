'use strict';
// ─── MBI Guardian: qachon xabar yuborishni hal qiladi (sof funksiya — test qilinadi) ───
//  • crit — 2 marta ketma-ket tasdiqlansa xabar (qisqa uzilish spam bo'lmasin);
//           hal bo'lmasa har 12 soatda eslatma; tiklanganda "✅" xabari.
//  • warn / info — darhol xabar YO'Q, 18:30 kunlik xulosada ko'rinadi.
//  • muddat (meta.expiry) — 14, 7, 3, 1 kun qolganda bir martadan. Muddat yangilansa
//           (kunlar ko'paysa) bosqichlar qaytadan boshlanadi. Muddat bo'yicha crit alohida
//           "muammo" xabarini bermaydi — bir narsa ikki marta aytilmasin.

const CONFIRM_RUNS = 2;
const REALERT_MS = 12 * 3600 * 1000;
const EXPIRY_STEPS = [14, 7, 3, 1];

function expiryStep(days) {
  const hit = EXPIRY_STEPS.filter((s) => days <= s);
  return hit.length ? hit[hit.length - 1] : null;
}

function planAlerts(prevState, results, now) {
  const state = JSON.parse(JSON.stringify(prevState || {}));
  state.issues = state.issues || {};
  state.expiry = state.expiry || {};
  const messages = [];
  const seen = new Set();

  for (const r of results) {
    seen.add(r.id);
    const cur = state.issues[r.id];

    if (r.meta && r.meta.expiry && typeof r.meta.days === 'number') {
      // ilgari o'lik deb xabar qilingan token endi ishlasa — tiklandi
      if (cur) {
        if (cur.alertedAt) messages.push({ kind: 'recovered', id: r.id, text: `✅ ${r.name}: ${r.msg}` });
        delete state.issues[r.id];
      }
      const step = expiryStep(r.meta.days);
      const last = state.expiry[r.id];
      if (step != null && (last == null || step < last)) {
        messages.push({ kind: 'expiry', id: r.id, text: `⏳ ${r.name}: ${r.msg}` });
        state.expiry[r.id] = step;
      } else if (step == null && last != null) {
        delete state.expiry[r.id];
      }
      continue;
    }

    if (r.level === 'crit') {
      const it = cur || { streak: 0, firstSeen: now, alertedAt: null };
      it.streak += 1;
      it.name = r.name;
      it.msg = r.msg;
      if (it.streak >= CONFIRM_RUNS && (!it.alertedAt || now - it.alertedAt >= REALERT_MS)) {
        messages.push({ kind: 'problem', id: r.id, text: `❌ ${r.name}: ${r.msg}`, firstSeen: it.firstSeen, repeat: !!it.alertedAt });
        it.alertedAt = now;
      }
      state.issues[r.id] = it;
    } else if (cur) {
      if (cur.alertedAt) messages.push({ kind: 'recovered', id: r.id, text: `✅ ${r.name}: ${r.msg}` });
      delete state.issues[r.id];
    }
  }

  // endi mavjud bo'lmagan tekshiruvlarning izi qolmasin
  for (const id of Object.keys(state.issues)) if (!seen.has(id)) delete state.issues[id];
  for (const id of Object.keys(state.expiry)) if (!seen.has(id)) delete state.expiry[id];
  return { messages, state };
}

module.exports = { planAlerts, expiryStep, CONFIRM_RUNS, REALERT_MS, EXPIRY_STEPS };
