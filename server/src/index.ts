import express from 'express';
import { appointments, assignTask, blocks, containerDetail, containers, createContainer, createGateAppointment, createYardTask, dashboard, deleteContainer, deleteGateAppointment, deleteYardTask, editGateAppointment, equipment, gateConflicts, prioritizeTasks, tasks, updateContainer, updateYardTask, voyages, yardHeatmap } from './domain.js';
import { cancelReplan, confirmReplan, getReplanSession, listReplanSessions, receiveNewEta, selectOption, startReplan, bumpStateVersion, ReplanError } from './replan.js';
const app = express(); app.use(express.json());
app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
app.get('/api/voyages', (_req, res) => res.json(voyages));
app.get('/api/containers', (req, res) => res.json(req.query.status ? containers.filter(c => c.status === req.query.status) : containers));
app.post('/api/containers', (req, res) => { try { res.status(201).json(createContainer(req.body)); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '创建箱务记录失败' }); } });
app.patch('/api/containers/:id', (req, res) => { try { const result = updateContainer(req.params.id, req.body); if (!result) return res.status(404).json({ message: '箱号不存在' }); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新箱务记录失败' }); } });
app.delete('/api/containers/:id', (req, res) => { const result = deleteContainer(req.params.id); if (!result) return res.status(404).json({ message: '箱号不存在' }); res.json({ deleted: true, id: result.id }); });
app.get('/api/containers/:id', (req, res) => { const result = containerDetail(req.params.id); if (!result) return res.status(404).json({ message: '箱号不存在' }); res.json(result); });
app.get('/api/yard/heatmap', (_req, res) => res.json(yardHeatmap()));
app.get('/api/yard/blocks', (_req, res) => res.json(blocks));
app.get('/api/gate/appointments', (_req, res) => res.json(appointments));
app.get('/api/gate/conflicts', (_req, res) => res.json(gateConflicts()));
app.post('/api/gate/appointments', (req, res) => { try { res.status(201).json(createGateAppointment(req.body)); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '预约失败' }); } });
app.patch('/api/gate/appointments/:id', (req, res) => { try { const result = editGateAppointment(req.params.id, req.body); if (!result) return res.status(404).json({ message: '预约不存在' }); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新预约失败' }); } });
app.delete('/api/gate/appointments/:id', (req, res) => { const result = deleteGateAppointment(req.params.id); if (!result) return res.status(404).json({ message: '预约不存在' }); res.json({ deleted: true, id: result.id }); });
app.get('/api/equipment', (_req, res) => res.json(equipment));
app.get('/api/tasks', (_req, res) => res.json(prioritizeTasks()));
app.post('/api/tasks', (req, res) => { try { res.status(201).json(createYardTask(req.body)); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '创建作业任务失败' }); } });
app.patch('/api/tasks/:id', (req, res) => { try { const result = updateYardTask(req.params.id, req.body); if (!result) return res.status(404).json({ message: '作业任务不存在' }); bumpStateVersion(); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新作业任务失败' }); } });
app.delete('/api/tasks/:id', (req, res) => { const result = deleteYardTask(req.params.id); if (!result) return res.status(404).json({ message: '作业任务不存在' }); res.json({ deleted: true, id: result.id }); });
app.patch('/api/tasks/:id/assign', (req, res) => { const result = assignTask(req.params.id, req.body.equipmentId); if (!result) return res.status(404).json({ message: '任务或设备不存在' }); bumpStateVersion(); res.json(result); });

/* ---------------- 泊位窗口重排 ---------------- */
function sendReplanError(res: express.Response, error: unknown) {
  if (error instanceof ReplanError) {
    const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFIRM_FAILED' ? 409 : error.code === 'STALE' ? 409 : 409;
    return res.status(status).json({ message: error.message, code: error.code, details: error.details });
  }
  return res.status(400).json({ message: error instanceof Error ? error.message : '重排请求失败' });
}
app.get('/api/replan/sessions', (_req, res) => res.json(listReplanSessions()));
app.post('/api/replan/sessions', (req, res) => { try { res.status(201).json(startReplan(req.body)); } catch (error) { sendReplanError(res, error); } });
app.get('/api/replan/sessions/:id', (req, res) => { const session = getReplanSession(req.params.id); if (!session) return res.status(404).json({ message: '重排会话不存在' }); res.json(session); });
app.post('/api/replan/sessions/:id/eta', (req, res) => { try { res.json(receiveNewEta(req.params.id, req.body.newEta, req.body.reason)); } catch (error) { sendReplanError(res, error); } });
app.post('/api/replan/sessions/:id/select', (req, res) => { try { res.json(selectOption(req.params.id, req.body.optionId)); } catch (error) { sendReplanError(res, error); } });
app.post('/api/replan/sessions/:id/confirm', (req, res) => { try { res.json(confirmReplan(req.params.id, { actor: req.body?.actor, injectFailChangeIds: req.body?.injectFailChangeIds })); } catch (error) { sendReplanError(res, error); } });
app.post('/api/replan/sessions/:id/cancel', (req, res) => { try { res.json(cancelReplan(req.params.id, req.body?.reason)); } catch (error) { sendReplanError(res, error); } });

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'port-yard-operations' }));
const port = Number(process.env.PORT || 4107); app.listen(port, () => console.log(`port yard API listening on ${port}`));
