import test from 'node:test';
import assert from 'node:assert/strict';
import { appointments, tasks, voyages } from './domain.js';
import { cancelReplan, confirmReplan, receiveNewEta, selectOption, startReplan, ReplanError } from './replan.js';

const minutes = (value: number) => new Date(Date.now() + value * 60000).toISOString();

test('replan: 两个航次窗口冲突时，顺延方案级联平移后续航次与任务，已开始作业保持冻结', () => {
  const qf2 = voyages.find(v => v.id === 'VOY-QF2')!;
  const newEta = new Date(new Date(qf2.eta).getTime() + 110 * 60000).toISOString();
  const session = startReplan({ voyageId: 'VOY-QF2', newEta, reason: '台风过境，预计晚到 110 分钟' });

  const sequence = session.options.find(o => o.id === 'sequence')!;
  assert.equal(sequence.feasible, true);
  // QF2 推迟后与 KM3 在 B04 冲突，KM3 必须被级联
  assert.equal(sequence.cascadeVoyages.some(i => i.voyageId === 'VOY-KM3'), true);
  const km3 = sequence.cascadeVoyages.find(i => i.voyageId === 'VOY-KM3')!;
  assert.ok(km3.shiftMinutes > 0, '后续航次被顺延');
  assert.ok(sequence.changes.some(c => c.type === 'task-shift' && c.entityId === 'TASK-110'), 'KM3 装船任务联动平移');
  // 每个可移动变更必须带推迟原因
  for (const change of sequence.changes.filter(c => c.type === 'voyage-window' || c.type === 'task-shift' || c.type === 'appointment-shift')) {
    assert.ok(change.reason.text.length > 5, `${change.type} ${change.entityId} 必须记录原因`);
    assert.equal(change.reason.direction, 'delayed');
  }
  assert.equal(session.options.some(o => o.id === 'berth-switch'), true);
  assert.equal(session.options.some(o => o.id === 'eta-only'), true);
  assert.notEqual(session.options.find(o => o.id === 'eta-only')!.recommended, true);
  cancelReplan(session.id, '测试清理');
});

test('replan: 已开始（executing/done）作业不可回滚，方案中以冻结变更呈现', () => {
  const ax7 = voyages.find(v => v.id === 'VOY-AX7')!;
  const newEtd = new Date(new Date(ax7.etd).getTime() + 90 * 60000).toISOString();
  const session = startReplan({ voyageId: 'VOY-AX7', newEta: ax7.eta, requestedEtd: newEtd, reason: '在泊作业延误，延长离泊' });
  // 在泊航次没有顺延/换泊/锚地方案，只有压缩与 ETA 基线
  assert.deepEqual(session.options.map(o => o.id).sort(), ['compress', 'eta-only']);
  const compress = session.options.find(o => o.id === 'compress')!;
  const frozen = compress.changes.filter(c => c.frozen);
  assert.ok(frozen.some(c => c.entityId === 'TASK-100'), '执行中的 TASK-100 必须冻结');
  assert.ok(frozen.every(c => c.frozenReason && c.frozenReason.length > 0));
  // 执行中任务不在可移动任务数里
  assert.equal(compress.changes.filter(c => c.type === 'task-shift' && c.entityId === 'TASK-100').length, 0);
  cancelReplan(session.id, '测试清理');
});

test('replan: 设备被其他航次锁定时给出换桥/锁定提示，不能抢占', () => {
  const qf2 = voyages.find(v => v.id === 'VOY-QF2')!;
  const newEta = new Date(new Date(qf2.eta).getTime() + 110 * 60000).toISOString();
  const session = startReplan({ voyageId: 'VOY-QF2', newEta, reason: '延误重排' });
  const sequence = session.options.find(o => o.id === 'sequence')!;
  // QC-04 锁定给 KM3，方案里必须有锁定提示（设备冻结）或任务改派
  const lockAdvisory = sequence.changes.find(c => c.entityId === 'QC-04' && c.frozen);
  assert.ok(lockAdvisory, 'QC-04 被 KM3 锁定，方案应显式冻结并说明');
  assert.match(lockAdvisory!.frozenReason!, /VOY-KM3/);
  cancelReplan(session.id, '测试清理');
});

test('replan: 重排中又收到新 ETA，原方案作废并按新 ETA 重算', () => {
  const qf2 = voyages.find(v => v.id === 'VOY-QF2')!;
  const session = startReplan({ voyageId: 'VOY-QF2', newEta: new Date(new Date(qf2.eta).getTime() + 60 * 60000).toISOString(), reason: '第一次延误更新' });
  receiveNewEta(session.id, new Date(new Date(qf2.eta).getTime() + 200 * 60000).toISOString(), '船方二次更新：航道管制');
  assert.ok(session.etaNotice);
  assert.equal(session.selectedOptionId, undefined, '已选方案应被清空');
  const sequence = session.options.find(o => o.id === 'sequence')!;
  assert.equal(sequence.targetVoyage.after.eta, session.triggerEta);
  const km3 = sequence.cascadeVoyages.find(i => i.voyageId === 'VOY-KM3');
  assert.ok(km3 && km3.shiftMinutes > 100, '按 +200 分钟重新级联');
  cancelReplan(session.id, '测试清理');
});

test('replan: 提前靠泊生成压缩/锚地方案，确认后批量更新窗口、任务、预约与箱务原因', () => {
  const qf2 = voyages.find(v => v.id === 'VOY-QF2')!;
  const etaBefore = qf2.eta;
  const earlyEta = new Date(new Date(qf2.eta).getTime() - 80 * 60000).toISOString();
  const session = startReplan({ voyageId: 'VOY-QF2', newEta: earlyEta, reason: '海上提速，提前 80 分钟抵港' });
  assert.ok(session.options.some(o => o.id === 'anchorage-hold'), '提前到港应给出锚地等待方案');
  const sequence = session.options.find(o => o.id === 'sequence')!;
  assert.equal(sequence.targetVoyage.shiftMinutes, -80);
  assert.ok(sequence.changes.some(c => c.type === 'task-shift' && c.entityId === 'TASK-104' && c.reason.direction === 'advanced'));

  const apt9005 = appointments.find(a => a.id === 'APT-9005')!;
  const aptBefore = apt9005.windowStart;
  const task104 = tasks.find(t => t.id === 'TASK-104')!;
  const taskBefore = task104.scheduledAt;

  selectOption(session.id, 'sequence');
  const confirmed = confirmReplan(session.id);
  assert.equal(confirmed.status, 'confirmed');
  assert.ok(Date.parse(qf2.eta) < Date.parse(etaBefore), 'ETA 已提前');
  assert.ok(Date.parse(task104.scheduledAt) < Date.parse(taskBefore), '任务计划提前');
  assert.ok(Date.parse(apt9005.windowStart) < Date.parse(aptBefore), '闸口预约提前');
  assert.match(task104.rescheduleNote ?? '', /提前/, '任务记录提前原因');
  assert.match(apt9005.exception ?? '', /提前/, '预约记录提前原因');
  assert.ok((qf2.windowHistory ?? []).some(h => h.sessionId === session.id && /提前/.test(h.reason)), '航次窗口历史记录原因');
  assert.ok(confirmed.applyResults!.some(r => r.applied && r.type === 'container-note'), '箱务被批量标注');
});

test('replan: 确认时发现任务已开始（依据失效），拒绝确认且数据不变', () => {
  const qf2 = voyages.find(v => v.id === 'VOY-QF2')!;
  const session = startReplan({ voyageId: 'VOY-QF2', newEta: minutes(999), reason: '延误重排' });
  selectOption(session.id, 'sequence');
  // 调度员确认前，现场把 TASK-104 开干了
  const task104 = tasks.find(t => t.id === 'TASK-104')!;
  task104.status = 'executing';
  assert.throws(() => confirmReplan(session.id), (error: unknown) => error instanceof ReplanError && error.code === 'STALE');
  assert.equal(session.status, 'stale');
  assert.ok(session.validationErrors?.some(e => e.code === 'TASK_STARTED'));
  // 现场数据未被污染
  assert.equal(task104.scheduledAt, tasks.find(t => t.id === 'TASK-104')!.scheduledAt);
  task104.status = 'queued';
  cancelReplan(session.id, '测试清理');
});

test('replan: 写入阶段部分失败时整批回滚，再取消恢复到会话基线', () => {
  const qf2 = voyages.find(v => v.id === 'VOY-QF2')!;
  const etaBefore = qf2.eta;
  const session = startReplan({ voyageId: 'VOY-QF2', newEta: minutes(1234), reason: '故障注入测试' });
  const sequence = session.options.find(o => o.id === 'sequence')!;
  selectOption(session.id, 'sequence');
  const victim = sequence.changes.find(c => c.type === 'task-shift' && !c.frozen)!;
  assert.throws(() => confirmReplan(session.id, { injectFailChangeIds: [victim.id] }), (error: unknown) => error instanceof ReplanError && error.code === 'CONFIRM_FAILED');
  assert.equal(session.status, 'failed');
  // 失败后已写入项全部回滚
  assert.equal(qf2.eta, etaBefore, '航次窗口必须回滚');
  assert.ok(session.applyResults!.length > 0);
  // 取消再兜底恢复，数据仍等于基线
  const cancelled = cancelReplan(session.id, '故障演练结束');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(qf2.eta, etaBefore);
});

test('replan: 取消草稿后航次 ETA 与 reportedEta 恢复为重排前', () => {
  const qf2 = voyages.find(v => v.id === 'VOY-QF2')!;
  const etaBefore = qf2.eta;
  const reportedBefore = qf2.reportedEta;
  const session = startReplan({ voyageId: 'VOY-QF2', newEta: minutes(1700), reason: '取消恢复测试' });
  assert.notEqual(qf2.reportedEta, undefined);
  cancelReplan(session.id, '调度员放弃');
  assert.equal(qf2.eta, etaBefore);
  assert.equal(qf2.reportedEta, reportedBefore);
});

