import test from 'node:test';
import assert from 'node:assert/strict';
import { auditEvents, appointments, tasks, voyages } from './domain.js';
import { ReplanError, __setFaultStep, cancelReplan, confirmReplan, getSession, ingestVoyageEta, listSessions, startReplan } from './replan.js';

const MINUTE = 60000;
const shifted = (iso: string, minutes: number) => new Date(new Date(iso).getTime() + minutes * MINUTE).toISOString();
const option = (session: ReturnType<typeof getSession>, id: string) => session.options.find(o => o.id === id)!;
const findTask = (id: string) => tasks.find(t => t.id === id)!;
const findVoyage = (id: string) => voyages.find(v => v.id === id)!;
const findAppointment = (id: string) => appointments.find(a => a.id === id)!;

test('重排会话生成多套可比方案，并检出两个航次的泊位窗口冲突', () => {
  const qf2 = findVoyage('VOY-QF2');
  const session = startReplan({ voyageId: 'VOY-QF2', targetEta: shifted(qf2.eta, -30), reason: '船方报提前 30 分钟靠泊' });
  assert.equal(session.status, 'draft');
  assert.equal(session.trigger, 'advance');
  assert.ok(session.options.length >= 4, '应包含平移、压缩、多个换泊方案');

  const swapB07 = option(session, 'swap-berth-B07');
  assert.equal(swapB07.feasibility, 'blocked');
  assert.ok(swapB07.blockers.some(reason => reason.includes('VOY-AX7') && reason.includes('冲突')));

  // 已确认的航次变化（ETA 提前 30）和方案结论挂在同一张方案上
  assert.equal(swapB07.voyageChange.eta.direction, 'earlier');
  assert.equal(swapB07.voyageChange.eta.deltaMinutes, -30);
  assert.ok(swapB07.voyageChange.reason.includes('提前'));
  assert.equal(swapB07.score < 35, true);
});

test('设备被其他航次锁定时给出解除指派的任务级影响', () => {
  const qf2 = findVoyage('VOY-QF2');
  // QF2 提前后 TASK-104(YC-05) 的新时刻与 AX7 的 TASK-105(YC-05) 重叠
  const session = startReplan({ voyageId: 'VOY-QF2', targetEta: shifted(qf2.eta, -30), reason: '提前靠泊设备冲突演练' });
  const shift = option(session, 'shift-window');
  const task104 = shift.taskImpacts.find(t => t.taskId === 'TASK-104')!;
  assert.equal(task104.decision, 'unassign');
  assert.equal(task104.equipmentId, undefined);
  assert.ok(task104.reasons.some(r => r.includes('VOY-AX7') && r.includes('占用')));
  assert.ok(shift.equipmentLocks.some(lock => lock.equipmentId === 'YC-05' && lock.ownerVoyageId === 'VOY-AX7'));
});

test('已开始作业不可回滚：靠泊航次 ETA 提前被阻断，executing 任务保持原位', () => {
  const ax7 = findVoyage('VOY-AX7');
  const early = startReplan({ voyageId: 'VOY-AX7', targetEta: shifted(ax7.eta, -60), reason: '试图让在港航次提前靠泊' });
  assert.equal(option(early, 'shift-window').feasibility, 'blocked');
  assert.ok(option(early, 'shift-window').blockers.some(r => r.includes('已开始作业不可回滚')));

  // 航次推迟时，正在执行的卸船任务只能 hold，不参与平移
  const late = startReplan({ voyageId: 'VOY-AX7', targetEta: shifted(ax7.eta, 60), reason: '港池交通管制推迟 60 分钟' });
  const task106 = option(late, 'shift-window').taskImpacts.find(t => t.taskId === 'TASK-106')!;
  assert.equal(task106.decision, 'hold');
  assert.equal(task106.deltaMinutes, 0);
  assert.ok(task106.reasons.some(r => r.includes('已开始作业不可回滚')));
});

test('确认方案后批量更新航次、任务、预约与箱务并记录推迟原因', () => {
  const qf2 = findVoyage('VOY-QF2');
  const baseVersion = qf2.etaVersion;
  const etaBefore = qf2.eta;
  const task104Before = findTask('TASK-104').scheduledAt;
  const apt9004Before = findAppointment('APT-9004').windowStart;

  const session = startReplan({ voyageId: 'VOY-QF2', targetEta: shifted(etaBefore, 120), reason: '前序港口拥堵，船方报延误 2 小时' });
  const result = confirmReplan(session.id, session.preferredOptionId);
  assert.equal(result.session.status, 'confirmed');

  assert.equal(findVoyage('VOY-QF2').eta, shifted(etaBefore, 120));
  assert.equal(findVoyage('VOY-QF2').etaVersion, baseVersion + 1);
  assert.ok(findVoyage('VOY-QF2').shiftReason?.includes('推迟'));
  assert.equal(findTask('TASK-104').scheduledAt, shifted(task104Before, 120));
  assert.ok(findTask('TASK-104').shiftReason?.includes('随航次推迟'));
  assert.equal(findAppointment('APT-9004').windowStart, shifted(apt9004Before, 120));
  assert.ok(result.changes.summary.shiftedTasks >= 1);
  assert.ok(result.changes.containers.some(c => c.lastEvent.includes('窗口重排')));
  assert.ok(auditEvents.some(e => e.action === 'REPLAN_APPLIED'));
});

test('重排进行中收到新 ETA：旧会话过期，基于旧方案确认被拒', () => {
  const qf2 = findVoyage('VOY-QF2');
  const dwell = new Date(qf2.etd).getTime() - new Date(qf2.eta).getTime();
  const planEta = shifted(qf2.eta, 60);
  const planEtd = new Date(new Date(planEta).getTime() + dwell).toISOString();
  const session = startReplan({ voyageId: 'VOY-QF2', targetEta: planEta, targetEtd: planEtd, reason: '调度员手工预案' });
  const baseVersion = findVoyage('VOY-QF2').etaVersion;

  const nextEta = shifted(qf2.eta, -45);
  const nextEtd = new Date(new Date(nextEta).getTime() + dwell).toISOString();
  const { superseded, session: fresh } = ingestVoyageEta('VOY-QF2', { eta: nextEta, etd: nextEtd, reason: '船方加速，ETA 提前 45 分钟' });
  assert.deepEqual(superseded, [session.id]);
  assert.equal(getSession(session.id).status, 'stale');
  assert.equal(findVoyage('VOY-QF2').etaVersion, baseVersion + 1);
  assert.equal(fresh.baseEtaVersion, baseVersion + 1);

  assert.throws(() => confirmReplan(session.id, session.preferredOptionId), (error: unknown) =>
    error instanceof ReplanError && error.code === 'SESSION_STALE');
});

test('部分更新失败时已写入对象全部回滚，失败会话可取消恢复', () => {
  const ax7 = findVoyage('VOY-AX7');
  const etaBefore = ax7.eta;
  const versionBefore = ax7.etaVersion;
  const task101Before = findTask('TASK-101').scheduledAt;

  const session = startReplan({ voyageId: 'VOY-AX7', targetEta: shifted(ax7.eta, 90), reason: '航道疏浚夜间管制' });
  __setFaultStep('tasks');
  assert.throws(() => confirmReplan(session.id, session.preferredOptionId), (error: unknown) =>
    error instanceof ReplanError && error.code === 'PARTIAL_UPDATE_FAILED');
  __setFaultStep(null);

  // 航次（步骤 1 已写入）也必须随快照回滚
  assert.equal(findVoyage('VOY-AX7').eta, etaBefore);
  assert.equal(findVoyage('VOY-AX7').etaVersion, versionBefore);
  assert.equal(findTask('TASK-101').scheduledAt, task101Before);
  assert.equal(getSession(session.id).status, 'failed');
  assert.ok(getSession(session.id).recoverySnapshot);

  const cancelled = cancelReplan(session.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.note?.includes('还原'));
  assert.equal(findVoyage('VOY-AX7').eta, etaBefore);
});

test('取消未确认的重排不会写入任何变化', () => {
  const qf2 = findVoyage('VOY-QF2');
  const etaBefore = qf2.eta;
  const task104Before = findTask('TASK-104').scheduledAt;
  const session = startReplan({ voyageId: 'VOY-QF2', targetEta: shifted(qf2.eta, -30), reason: '临时讨论后放弃' });
  const cancelled = cancelReplan(session.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(findVoyage('VOY-QF2').eta, etaBefore);
  assert.equal(findTask('TASK-104').scheduledAt, task104Before);
});

test('会话列表与按航次查询可用', () => {
  const all = listSessions();
  assert.ok(all.length >= 6);
  assert.ok(listSessions('VOY-AX7').every(s => s.voyageId === 'VOY-AX7'));
});
