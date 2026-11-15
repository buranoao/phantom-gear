/*
 * J_Phantom_Gear 計算の心臓部（ページと Google の受け口の両方で同じ物を使う）
 *  - recalculateAll : app.py の recalculate_all を1行ずつ移したもの（今のアプリと1円も違わないことを試験で確かめる）
 *  - computeReward  : 2026-11-12 本人の決まりの成功報酬（同じ日はまとめる・プラスに出た分だけ報酬・損は残債として積む）
 */
var JPG = (function () {
  'use strict';
  var BUY = ['買い', '新規買付', '買い増し'];
  var SELL = ['売り', '売却'];
  var RATE = 0.15;

  // ---- Python と同じふるまいをする小道具 ----
  function pyErr(kind, msg) { var e = new Error(msg); e.pyKind = kind; return e; }
  function pyStr(v) {
    if (v === null || v === undefined) return 'None';
    if (typeof v === 'number' && isNaN(v)) return 'nan';
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    return String(v);
  }
  function pyTruthy(v) {
    if (v === null || v === undefined) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0; // NaN は真（Python と同じ）
    if (typeof v === 'string') return v.length > 0;
    return true;
  }
  var NUM_RE = /^[+-]?((\d[\d_]*)(\.[\d_]*)?|\.\d[\d_]*)([eE][+-]?\d+)?$/;
  function pyFloat(v) {
    if (v === null || v === undefined) throw pyErr('TypeError', 'float() argument must be a number');
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return v;
    var s = String(v).trim();
    if (/^[+-]?nan$/i.test(s)) return NaN;
    if (/^[+-]?(inf|infinity)$/i.test(s)) return s.charAt(0) === '-' ? -Infinity : Infinity;
    if (!NUM_RE.test(s)) throw pyErr('ValueError', 'could not convert string to float');
    return Number(s.replace(/_/g, ''));
  }
  function pyIntOfFloat(f) {
    if (isNaN(f)) throw pyErr('ValueError', 'cannot convert float NaN to integer');
    if (!isFinite(f)) throw pyErr('OverflowError', 'cannot convert float infinity to integer');
    return Math.trunc(f);
  }
  function pyInt(x) { // int(float) の切り捨て（0 に向かって）
    if (isNaN(x)) throw pyErr('ValueError', 'cannot convert float NaN to integer');
    if (!isFinite(x)) throw pyErr('OverflowError', 'cannot convert float infinity to integer');
    return Math.trunc(x);
  }
  function pyRound2(x) { // Python の round(x, 2)（ちょうど半分の時だけ偶数へ）
    if (!isFinite(x)) return x;
    var y = x * 100;
    if (Number.isInteger(x * 8) && Math.abs(y % 1) === 0.5) {
      var f = Math.floor(y);
      var n = (f % 2 === 0) ? f : f + 1;
      return n / 100;
    }
    return Number(x.toFixed(2));
  }
  function getOr(o, k, d) { return (o && Object.prototype.hasOwnProperty.call(o, k)) ? o[k] : d; }
  function containsJapanese(t) { return /[ぁ-んァ-ン一-龥]/.test(pyStr(t)); }
  function isCleanName(n) {
    var ns = pyStr(n);
    if (!ns || ns.indexOf('コード(') >= 0 || ns.indexOf('Yahoo!') >= 0 || ns.indexOf('表示できません') >= 0) return false;
    return true;
  }
  function has(s, sub) { return pyStr(s).indexOf(sub) >= 0; }
  function upd(log, obj) { for (var k in obj) log[k] = obj[k]; }

  // ---- recalculate_all（app.py 262〜415行） ----
  function recalculateAll(inputLogs) {
    var logs = inputLogs.map(function (l) { var c = {}; for (var k in l) c[k] = l[k]; return c; });
    function valid(r) {
      var d = getOr(r, '日付', null), k = getOr(r, '区分', null);
      if (d === null || d === undefined || k === null || k === undefined) return false;
      if (['', 'NaT', 'nan', 'None'].indexOf(pyStr(d).trim()) >= 0) return false;
      if (['', 'nan', 'None'].indexOf(pyStr(k).trim()) >= 0) return false;
      return true;
    }
    var sorted = logs.filter(valid);
    sorted.sort(function (a, b) { var x = String(a['日付']), y = String(b['日付']); return x < y ? -1 : x > y ? 1 : 0; }); // 安定ソート
    var portfolio = new Map();
    var processed = [];
    var after = []; // 各行の後の建玉（報酬の計算で使う・比べる対象ではない）
    var pre = []; // 各行の前の建玉（手仕舞いの報告の買値に使う・比べる対象ではない）
    var curPre = null;
    function snap(code) { var p = portfolio.get(code); after.push({ code: code, qty: p ? p.qty : 0, side: p ? p.position_side : 'long', avg: p ? p.avg_price : 0 }); pre.push(curPre); }

    for (var i = 0; i < sorted.length; i++) {
      var log = sorted[i];
      var code = pyStr(log['証券コード']).trim();
      var pp = portfolio.get(code); curPre = pp ? { qty: pp.qty, avg: pp.avg_price, side: pp.position_side } : null;
      var tradeType = log['区分'];
      var isBonus = getOr(log, 'ボーナス', false);

      if (tradeType === 'データ調整' || tradeType === '報酬精算') { processed.push(log); snap(code); continue; }

      if (tradeType === '恩株精算') {
        var settlePrice = pyFloat(log['約定単価']);
        var ps = portfolio.get(code);
        if (ps && getOr(ps, 'avg_price', 0) === 0 && getOr(ps, 'qty', 0) > 0) {
          ps.avg_price = settlePrice;
          ps.original_avg = settlePrice;
        }
        upd(log, { '確定損益': 0 });
        processed.push(log); snap(code);
        continue;
      }

      var qty, price;
      try {
        qty = pyIntOfFloat(pyFloat(log['数量']));
        price = pyFloat(log['約定単価']);
      } catch (e) {
        if (e.pyKind === 'TypeError' || e.pyKind === 'ValueError') {
          upd(log, { '確定損益': 0 });
          processed.push(log); snap(code);
          continue;
        }
        throw e;
      }

      var logName = getOr(log, '銘柄名', '');
      var cpn = portfolio.has(code) ? getOr(portfolio.get(code), 'name', '') : '';
      var finalName = 'コード(' + code + ')';
      if (isCleanName(cpn)) finalName = cpn;
      else if (isCleanName(logName)) finalName = logName;

      var cur, p0 = portfolio.get(code);
      if (BUY.indexOf(tradeType) >= 0) {
        if (p0 && p0.qty > 0 && getOr(p0, 'position_side', 'long') === 'short') {
          upd(log, { '確定損益': 0, '銘柄名': p0.name }); processed.push(log); snap(code); continue;
        }
        if (!p0) portfolio.set(code, { name: finalName, qty: 0, avg_price: 0.0, realized_pl: 0, original_avg: 0.0, position_side: 'long' });
        cur = portfolio.get(code);
        if (containsJapanese(finalName) && !containsJapanese(cur.name)) cur.name = finalName;
        else if (has(cur.name, 'コード(') && !has(finalName, 'コード(')) cur.name = finalName;

        var totalCost = (cur.qty * cur.avg_price) + (qty * price);
        var baseAvg = getOr(cur, 'original_avg', cur.avg_price);
        if (baseAvg === 0 && cur.qty === 0) baseAvg = price;
        else if (baseAvg === 0 && cur.avg_price > 0) baseAvg = cur.avg_price;
        var totalRealCost = (cur.qty * baseAvg) + (qty * price);
        var totalQty = cur.qty + qty;
        var newAvg = totalQty > 0 ? totalCost / totalQty : 0.0;
        var newRealAvg = totalQty > 0 ? totalRealCost / totalQty : 0.0;
        upd(cur, { qty: totalQty, avg_price: newAvg, original_avg: newRealAvg, position_side: 'long' });
        upd(log, { '平均単価': pyRound2(newAvg), '確定損益': 0, '銘柄名': cur.name });

      } else if (tradeType === '新規売り') {
        if (p0 && p0.qty > 0 && getOr(p0, 'position_side', 'long') === 'long') {
          upd(log, { '確定損益': 0, '銘柄名': p0.name }); processed.push(log); snap(code); continue;
        }
        if (!p0) portfolio.set(code, { name: finalName, qty: 0, avg_price: 0.0, realized_pl: 0, original_avg: 0.0, position_side: 'short' });
        cur = portfolio.get(code);
        if (containsJapanese(finalName) && !containsJapanese(cur.name)) cur.name = finalName;
        else if (has(cur.name, 'コード(') && !has(finalName, 'コード(')) cur.name = finalName;
        var totalProceeds = (cur.qty * cur.avg_price) + (qty * price);
        var tq = cur.qty + qty;
        var na = tq > 0 ? totalProceeds / tq : 0.0;
        upd(cur, { qty: tq, avg_price: na, original_avg: na, position_side: 'short' });
        upd(log, { '平均単価': pyRound2(na), '確定損益': 0, '銘柄名': cur.name });

      } else if (tradeType === '買い戻し') {
        if (p0 && getOr(p0, 'position_side', 'long') === 'short' && p0.qty > 0) {
          cur = p0;
          var fill = Math.min(qty, cur.qty);
          var profit = (cur.avg_price - price) * fill;
          var newQty = cur.qty - fill;
          cur.realized_pl += profit;
          cur.qty = newQty;
          if (newQty === 0) cur.position_side = 'long';
          upd(log, { '平均単価': pyRound2(cur.avg_price), '確定損益': pyInt(profit), '銘柄名': cur.name });
        } else {
          upd(log, { '確定損益': 0 });
        }

      } else if (SELL.indexOf(tradeType) >= 0) {
        if (p0 && getOr(p0, 'position_side', 'long') === 'short' && p0.qty > 0) {
          upd(log, { '確定損益': 0, '銘柄名': p0.name }); processed.push(log); snap(code); continue;
        }
        if (p0) {
          cur = p0;
          var f2 = Math.min(qty, cur.qty);
          var pr;
          if (pyTruthy(isBonus)) {
            var totalHoldingCost = cur.qty * cur.avg_price;
            var sellAmount = f2 * price;
            if (sellAmount >= totalHoldingCost) {
              pr = sellAmount - totalHoldingCost;
              cur.qty = cur.qty - f2;
              cur.avg_price = 0.0;
              cur.realized_pl += pr;
              upd(log, { '平均単価': 0, '確定損益': pyInt(pr), '銘柄名': cur.name });
            } else {
              pr = (price - cur.avg_price) * f2;
              cur.qty = cur.qty - f2;
              cur.realized_pl += pr;
              upd(log, { '平均単価': pyRound2(cur.avg_price), '確定損益': pyInt(pr), '銘柄名': cur.name });
            }
          } else {
            pr = (price - cur.avg_price) * f2;
            cur.qty = cur.qty - f2;
            cur.realized_pl += pr;
            upd(log, { '平均単価': pyRound2(cur.avg_price), '確定損益': pyInt(pr), '銘柄名': cur.name });
          }
        }
      }
      processed.push(log); snap(code);
    }
    return { portfolio: portfolio, logs: processed, after: after, pre: pre };
  }

  // ---- 新しい成功報酬（2026-11-12 本人の決まり） ----
  // ・データ調整＝一番最初の残債（日付に関係なく最初に置く）
  // ・同じ日の確定損益はまとめて1日分
  // ・日ごとに 残債＋その日の分 がプラスに出たら、出た分が報酬の元（15%）→ 残債は0に戻す。マイナスなら▲として積む
  // ・恩株を受領した銘柄は、受領の後の損益を外す（その銘柄を全部手放したら、次に買った分から対象に戻す）
  // ・報酬精算（支払い完了）は「払った」の記録だけ＝残債は動かさない
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  // ---- 恩株と別口（2026-11-15 本人の決まり・別の目の指摘で作り直し） ----
  // 1銘柄の持ち株を3つに分けて数える：恩株（買い取り済み）bq／買値0の株 free／買値のある株 pq・pc（free と pq を合わせて「別口」）
  // ・数え始め＝その銘柄に買値0の株ができた時（恩株化の売りで元手を回収）。そこから後の買いは、買値のある株として別に持つ
  //   （買い取りの記録より前の日付の買いを後から入れても、買い取りより前に買値0の株と分けて持つ＝混ざらない）
  // ・売りは 買値のある株 → 買値0の株 → 恩株 の順に減らす。恩株の分は報酬に入れない。それ以外は報酬に入れる
  //   （確定するまでは取引中＝買い取っていない買値0の株を売った代金も報酬に入る・2026-11-15 本人）
  // ・恩株化の売りで、別口の元手（買値のある株の分）を回収したら、残りの別口は全部買値0
  // ・恩株精算＝買値0の株を恩株へ移す（2回目からは合算）
  // ・その銘柄を全部手放したら（売り建てになっても）数えるのをやめる＝次に買った分からふつう
  // ★recalculateAll の数字（証券会社と同じ混ぜた平均＝履歴の確定損益）は変えない＝報酬と持ち株の見せ方だけに使う
  //   別口の数えが証券会社の数えと同じになる時（買値のある株も恩株も無い売り）は、履歴の確定損益をそのまま使う＝1円も違わない
  // 円にする＝小数の計算のずれ（11759.9999…）を先に丸めてから切り捨てる
  function yenOf(x) { return pyInt(Math.round(x * 1e6) / 1e6); }
  function computeLots(res) {
    var plogs = res.logs, after = res.after, pre = res.pre;
    var S = {}, rows = [];
    for (var i = 0; i < plogs.length; i++) {
      var l = plogs[i], k = l['区分'], code = pyStr(l['証券コード']).trim();
      var a = after[i] || { qty: 0, avg: 0, side: 'long' }, b = pre[i] || { qty: 0, avg: 0, side: 'long' };
      var s = S[code], r = null;
      if (k === 'データ調整' || k === '報酬精算') { rows.push(null); continue; }
      if (k === '恩株精算') {
        var rq = Math.max(0, Math.trunc(num(l['数量']))), sp = num(l['約定単価']), hold = Math.max(0, a.qty);
        if (!s && hold > 0 && a.side !== 'short') {   // 数え始める前の買い取り（古い記録の形）＝買値0なら全部を買値0の株として始める
          s = S[code] = num(b.avg) === 0 ? { bq: 0, bAvg: 0, free: hold, pq: 0, pc: 0 } : { bq: 0, bAvg: 0, free: 0, pq: hold, pc: hold * num(b.avg) };
        }
        if (s) {
          var want = rq > 0 ? rq : s.free + s.pq;   // 株数が空の古い記録＝前と同じく持ち株の全部
          var mf = Math.min(want, s.free), mp = Math.min(want - mf, s.pq);   // 買値のある株を買い取るのは古い記録の形だけ（受け口は買値0の株しか受け付けない）
          if (mf + mp > 0) {
            var cp = mp > 0 ? s.pc * mp / s.pq : 0;
            s.bAvg = (s.bq * s.bAvg + (mf + mp) * sp) / (s.bq + mf + mp);
            s.bq += mf + mp; s.free -= mf; s.pq -= mp; s.pc -= cp;
            if (s.pq <= 0) { s.pq = 0; s.pc = 0; }
          }
        }
      } else if (s) {
        r = { count: 0, ex: 0, fromExtra: 0, fromBonus: 0, plain: false };
        var pl = num(l['確定損益']);
        if (BUY.indexOf(k) >= 0) {
          var add = a.qty - b.qty;
          if (add > 0 && a.side !== 'short') { s.pq += add; s.pc += add * num(l['約定単価']); }
        } else if (SELL.indexOf(k) >= 0) {
          var sold = Math.max(0, b.qty - a.qty), px = num(l['約定単価']);
          var fp = Math.min(sold, s.pq), ff = Math.min(sold - fp, s.free), fb = Math.min(sold - fp - ff, s.bq), fe = fp + ff;
          if (fe > 0 && s.pq === 0 && fb === 0 && num(b.avg) === 0) {   // 買値0の株だけの売り＝証券会社の数えと同じ＝履歴の確定損益をそのまま
            r.count = pl; r.plain = true; s.free -= ff;
          } else if (fe > 0) {
            var pAvg = s.pq > 0 ? s.pc / s.pq : 0;
            if (pyTruthy(getOr(l, 'ボーナス', false)) && fe * px >= s.pc - 1e-6) {   // 恩株化の売りで別口の元手を回収＝残りの別口は全部買値0
              r.count = yenOf(fe * px - s.pc);
              s.free = s.free - ff + (s.pq - fp); s.pq = 0; s.pc = 0;
            } else {
              r.count = yenOf((px - pAvg) * fp + px * ff);
              s.pc -= pAvg * fp; s.pq -= fp; s.free -= ff;
              if (s.pq <= 0) { s.pq = 0; s.pc = 0; }
            }
          }
          if (fb > 0) { r.ex = fe > 0 ? yenOf((px - s.bAvg) * fb) : pl; s.bq -= fb; }
          r.fromExtra = fe; r.fromBonus = fb;
        } else {
          r.ex = pl;   // 恩株の銘柄で新規売り・買い戻しは起きない形＝今までどおり外す
        }
      }
      rows.push(r);
      if (S[code] && (a.qty <= 0 || a.side === 'short')) delete S[code];   // 全部手放した＝次に買った分からふつうに戻す
      else if (!S[code] && code && a.qty > 0 && a.side !== 'short' && num(a.avg) === 0 && SELL.indexOf(k) >= 0) S[code] = { bq: 0, bAvg: 0, free: a.qty, pq: 0, pc: 0 };   // 買値0の株ができた＝数え始める
    }
    var lots = {};
    Object.keys(S).forEach(function (c) {
      var s = S[c], eq = s.free + s.pq;
      lots[c] = { bonusQty: s.bq, bonusAvg: s.bAvg, freeQty: s.free, paidQty: s.pq, paidCost: s.pc, extraQty: eq, extraAvg: eq > 0 ? s.pc / eq : 0 };
    });
    return { rows: rows, lots: lots };
  }

  function computeReward(res) {
    var plogs = res.logs;
    var LT = computeLots(res);
    var start = 0, startDates = [];
    var days = []; var dayIndex = {};
    var excluded = [];
    var paidBase = 0, payments = [];
    for (var i = 0; i < plogs.length; i++) {
      var l = plogs[i], k = l['区分'], code = pyStr(l['証券コード']).trim(), pl = num(l['確定損益']);
      var d = String(l['日付']);
      if (k === '恩株精算') continue;
      if (k === 'データ調整') { start += pl; startDates.push(d); continue; }
      if (k === '報酬精算') {
        if (pyTruthy(getOr(l, 'ボーナス', false))) { payments.push({ date: d, base: -pl, bonus: true }); }
        else { paidBase += -pl; payments.push({ date: d, base: -pl, bonus: false }); }
        continue;
      }
      var sh = LT.rows[i];
      if (sh) {   // 恩株の銘柄＝恩株の分は外す・別口の分（別口の買値で数えた利益）だけ入れる
        if (sh.ex !== 0) excluded.push({ date: d, code: code, name: l['銘柄名'], kind: k, pl: sh.ex });
        pl = sh.count;
      }
      if (pl === 0) continue;
      if (!Object.prototype.hasOwnProperty.call(dayIndex, d)) { dayIndex[d] = days.length; days.push({ date: d, pl: 0, items: [] }); }
      var day = days[dayIndex[d]]; day.pl += pl; day.items.push({ code: code, name: l['銘柄名'], kind: k, pl: pl });
    }
    var B = start, earnedBase = 0, events = [], timeline = [];
    if (B > 0) { earnedBase += B; events.push({ date: startDates[0] || '', base: B, start: true }); B = 0; }
    for (var j = 0; j < days.length; j++) {
      var dd = days[j]; var before = B;
      B += dd.pl;
      var base = 0;
      if (B > 0) { base = B; earnedBase += B; events.push({ date: dd.date, base: B, dayPl: dd.pl }); B = 0; }
      timeline.push({ date: dd.date, dayPl: dd.pl, before: before, after: B, base: base, items: dd.items });
    }
    var settledNow = Object.keys(LT.lots).filter(function (c) { return LT.lots[c].bonusQty > 0; });
    return {
      start: start, balance: B, earnedBase: earnedBase, earned: earnedBase * RATE,
      paidBase: paidBase, unpaidBase: earnedBase - paidBase, unpaid: (earnedBase - paidBase) * RATE,
      events: events, timeline: timeline, excluded: excluded, payments: payments, settledCodes: settledNow,
      lots: LT.lots, lotRows: LT.rows
    };
  }

  return {
    RATE: RATE, BUY: BUY, SELL: SELL,
    recalculateAll: recalculateAll, computeReward: computeReward, computeLots: computeLots,
    containsJapanese: containsJapanese, isCleanName: isCleanName, pyRound2: pyRound2, pyStr: pyStr
  };
})();
if (typeof module !== 'undefined') module.exports = JPG;
