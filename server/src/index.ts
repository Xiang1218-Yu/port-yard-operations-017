import express from 'express';
import { appointments, assignTask, blocks, containerDetail, containers, createContainer, createGateAppointment, createYardTask, dashboard, deleteContainer, deleteGateAppointment, deleteYardTask, editGateAppointment, equipment, gateConflicts, prioritizeTasks, tasks, updateContainer, updateYardTask, voyages, yardHeatmap } from './domain.js';
import { ReplanError, cancelReplan, confirmReplan, getSession, ingestVoyageEta, listSessions, startReplan } from './replan.js';
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
app.patch('/api/tasks/:id', (req, res) => { try { const result = updateYardTask(req.params.id, req.body); if (!result) return res.status(404).json({ message: '作业任务不存在' }); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新作业任务失败' }); } });
app.delete('/api/tasks/:id', (req, res) => { const result = deleteYardTask(req.params.id); if (!result) return res.status(404).json({ message: '作业任务不存在' }); res.json({ deleted: true, id: result.id }); });
app.patch('/api/tasks/:id/assign', (req, res) => { const result = assignTask(req.params.id, req.body.equipmentId); if (!result) return res.status(404).json({ message: '任务或设备不存在' }); res.json(result); });

// ---------- 泊位窗口重排 ----------
const replanStatus = (code: string) => code === 'SESSION_NOT_FOUND' || code === 'VOYAGE_NOT_PLANNABLE' ? 404
  : code === 'SESSION_STALE' ? 409
  : code === 'PARTIAL_UPDATE_FAILED' ? 500
  : code === 'OPTION_NOT_AVAILABLE' ? 422
  : 400;
const replanError = (res: express.Response, error: unknown) => {
  if (error instanceof ReplanError) return res.status(replanStatus(error.code)).json({ message: error.message, code: error.code });
  return res.status(500).json({ message: error instanceof Error ? error.message : '重排失败' });
};
app.get('/api/replan/sessions', (req, res) => res.json(listSessions(typeof req.query.voyageId === 'string' ? req.query.voyageId : undefined)));
app.get('/api/replan/sessions/:id', (req, res) => { try { res.json(getSession(req.params.id)); } catch (error) { replanError(res, error); } });
app.post('/api/replan/sessions', (req, res) => {
  try { res.status(201).json(startReplan({ voyageId: req.body.voyageId, targetEta: req.body.targetEta, targetEtd: req.body.targetEtd, reason: req.body.reason, actor: req.body.actor })); }
  catch (error) { replanError(res, error); }
});
app.post('/api/replan/sessions/:id/confirm', (req, res) => {
  try { res.json(confirmReplan(req.params.id, req.body.optionId, req.body.actor)); }
  catch (error) { replanError(res, error); }
});
app.post('/api/replan/sessions/:id/cancel', (req, res) => {
  try { res.json(cancelReplan(req.params.id, req.body.actor)); }
  catch (error) { replanError(res, error); }
});
app.post('/api/voyages/:id/eta', (req, res) => {
  try { res.status(201).json(ingestVoyageEta(req.params.id, { eta: req.body.eta, etd: req.body.etd, reason: req.body.reason ?? '重排过程中收到新 ETA', actor: req.body.actor })); }
  catch (error) { replanError(res, error); }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'port-yard-operations' }));
const port = Number(process.env.PORT || 4107); app.listen(port, () => console.log(`port yard API listening on ${port}`));
