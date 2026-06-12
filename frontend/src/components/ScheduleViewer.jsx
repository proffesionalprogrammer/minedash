import React, { useState, useEffect } from 'react';
import { Calendar, Plus, Trash2, Power, X, Clock, Archive, RefreshCw, Terminal, Loader2, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import ModalPortal from './ModalPortal';
import Tooltip from './Tooltip';

const TASK_TYPES = [
  { value: 'backup', label: 'Create Backup', icon: Archive, desc: 'Run an auto-backup at this time' },
  { value: 'restart', label: 'Restart Server', icon: RefreshCw, desc: 'Stop then start the server' },
  { value: 'command', label: 'Run Command', icon: Terminal, desc: 'Send a console command (e.g. say, weather)' },
];

const DAYS = [
  { value: 0, short: 'S', label: 'Sun' },
  { value: 1, short: 'M', label: 'Mon' },
  { value: 2, short: 'T', label: 'Tue' },
  { value: 3, short: 'W', label: 'Wed' },
  { value: 4, short: 'T', label: 'Thu' },
  { value: 5, short: 'F', label: 'Fri' },
  { value: 6, short: 'S', label: 'Sat' },
];

function fmtTime(h, m) {
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return `${hh}:${mm}`;
}

function describeSchedule(task) {
  const { schedule } = task;
  const time = fmtTime(schedule.hour, schedule.minute);
  if (!schedule.days || schedule.days.length === 0) return `Every day at ${time}`;
  if (schedule.days.length === 7) return `Every day at ${time}`;
  const names = schedule.days.slice().sort().map(d => DAYS[d].label).join(', ');
  return `${names} at ${time}`;
}

function typeMeta(type) {
  return TASK_TYPES.find(t => t.value === type) || TASK_TYPES[0];
}

export default function ScheduleViewer({ serverId, onError }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [form, setForm] = useState({
    name: '',
    type: 'backup',
    command: '',
    hour: 3,
    minute: 0,
    days: [],
  });

  const resetForm = () => {
    setForm({ name: '', type: 'backup', command: '', hour: 3, minute: 0, days: [] });
    setFormError('');
  };

  const fetchTasks = async () => {
    setLoading(true);
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${serverId}/scheduled-tasks`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch scheduled tasks');
      setTasks(data);
    } catch (err) {
      if (onError) onError(err.message);
    }
    setLoading(false);
  };

  useEffect(() => { fetchTasks(); }, [serverId]);

  const toggleEnabled = async (task) => {
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, enabled: !task.enabled } : t));
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${serverId}/scheduled-tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !task.enabled }),
      });
      if (!res.ok) throw new Error('Failed to update task');
    } catch (err) {
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, enabled: task.enabled } : t));
      if (onError) onError(err.message);
    }
  };

  const deleteTask = async (task) => {
    setTasks(prev => prev.filter(t => t.id !== task.id));
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${serverId}/scheduled-tasks/${task.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete task');
    } catch (err) {
      await fetchTasks();
      if (onError) onError(err.message);
    }
  };

  const submitCreate = async () => {
    if (!form.name.trim()) { setFormError('Give the task a name.'); return; }
    if (form.type === 'command' && !form.command.trim()) { setFormError('A command is required.'); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${serverId}/scheduled-tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          type: form.type,
          command: form.type === 'command' ? form.command.trim() : undefined,
          schedule: { hour: Number(form.hour), minute: Number(form.minute), days: form.days },
          enabled: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create task');
      setTasks(prev => [...prev, data]);
      setShowCreate(false);
      resetForm();
    } catch (err) {
      setFormError(err.message);
    }
    setSubmitting(false);
  };

  const toggleDay = (d) => {
    setForm(f => ({
      ...f,
      days: f.days.includes(d) ? f.days.filter(x => x !== d) : [...f.days, d],
    }));
  };

  return (
    <div className="flex-1 bg-[#111111] rounded-2xl border border-[#2D2D2D] flex flex-col overflow-hidden relative">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#2D2D2D] bg-[#1A1A1A]">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[#00AF5C]/10 rounded-xl">
            <Calendar size={16} className="text-[#00AF5C]" />
          </div>
          <div>
            <h3 className="font-bold text-[#FFFFFF]">Scheduled Tasks</h3>
            <p className="text-xs text-[#A0A0A0]">Run actions on a recurring time-of-day schedule</p>
          </div>
        </div>
        <motion.button
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          onClick={() => { resetForm(); setShowCreate(true); }}
          className="flex items-center gap-2 px-4 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl font-bold text-sm transition-colors"
        >
          <Plus size={16} />
          <span>New Task</span>
        </motion.button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
        {loading ? (
          <div className="flex items-center justify-center h-full text-[#A0A0A0] font-medium">
            <Loader2 size={18} className="animate-spin mr-2" /> Loading tasks...
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center">
            <div className="p-5 bg-[#00AF5C]/5 rounded-3xl mb-5 border border-[#00AF5C]/10">
              <Calendar size={40} className="text-[#00AF5C]" />
            </div>
            <h4 className="text-base font-bold text-[#FFFFFF] mb-1">No scheduled tasks yet</h4>
            <p className="text-sm text-[#A0A0A0] max-w-sm">Schedule a 3am daily backup, a Sunday-morning restart, or a chat broadcast — anything you can do from the console.</p>
          </div>
        ) : (
          <div className="space-y-2 p-2">
            {tasks.map((task, i) => {
              const meta = typeMeta(task.type);
              const Icon = meta.icon;
              return (
                <motion.div
                  key={task.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.03, 0.3), duration: 0.25 }}
                  className={`flex items-center justify-between p-4 bg-[#1E1E1E] border rounded-2xl hover:border-[#555555] transition-all duration-200 group ${task.enabled ? 'border-[#2D2D2D]' : 'border-[#2D2D2D] opacity-60'}`}
                >
                  <div className="flex items-center gap-4 min-w-0 flex-1">
                    <div className={`p-3 rounded-xl border ${task.enabled ? 'bg-[#00AF5C]/10 text-[#00AF5C] border-[#00AF5C]/30' : 'bg-[#111111] text-[#A0A0A0] border-[#2D2D2D]'}`}>
                      <Icon size={20} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="font-bold text-[#FFFFFF] truncate">{task.name}</h4>
                        <span className="text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-md bg-[#A0A0A0]/10 text-[#A0A0A0]">
                          {meta.label}
                        </span>
                      </div>
                      <p className="text-xs text-[#A0A0A0] mt-1 truncate">
                        <Clock size={11} className="inline mr-1 -mt-0.5" />
                        {describeSchedule(task)}
                        {task.type === 'command' && task.command && (
                          <span className="text-[#555555]"> · <code className="font-mono">{task.command}</code></span>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 ml-2">
                    <Tooltip content={task.enabled ? 'Disable task' : 'Enable task'}>
                      <button
                        onClick={() => toggleEnabled(task)}
                        className={`p-2 rounded-xl transition-all duration-200 hover:scale-110 ${task.enabled ? 'text-[#00AF5C] hover:bg-[#00AF5C]/10' : 'text-[#555555] hover:text-[#A0A0A0] hover:bg-[#2D2D2D]'}`}
                      >
                        <Power size={18} />
                      </button>
                    </Tooltip>
                    <Tooltip content="Delete task" align="end">
                      <button
                        onClick={() => deleteTask(task)}
                        className="p-2 text-[#A0A0A0] hover:text-[#FF5555] hover:bg-[#FF5555]/10 rounded-xl transition-all duration-200 hover:scale-110 opacity-60 group-hover:opacity-100"
                      >
                        <Trash2 size={18} />
                      </button>
                    </Tooltip>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

      {/* Create modal */}
      <AnimatePresence>
        {showCreate && (
          <ModalPortal>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#000000]/80 z-[100] flex items-center justify-center backdrop-blur-sm"
            onClick={() => !submitting && setShowCreate(false)}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.92, opacity: 0 }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
              className="bg-[#1A1A1A] border border-[#2D2D2D] p-6 rounded-3xl w-full max-w-md shadow-2xl mx-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-[#00AF5C]/10 rounded-xl">
                    <Calendar size={16} className="text-[#00AF5C]" />
                  </div>
                  <h3 className="text-lg font-bold text-[#FFFFFF]">New Scheduled Task</h3>
                </div>
                <button
                  onClick={() => !submitting && setShowCreate(false)}
                  className="p-1.5 text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#2D2D2D] rounded-lg transition-colors"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-xs font-bold text-[#A0A0A0] block mb-1.5">Task name</label>
                  <input
                    autoFocus
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="Daily 3am backup"
                    disabled={submitting}
                    className="w-full bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] focus:ring-4 focus:ring-[#00AF5C]/10 rounded-xl px-3 py-2.5 text-sm text-[#FFFFFF] outline-none transition-all font-medium placeholder-[#555555]"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-[#A0A0A0] block mb-1.5">Action</label>
                  <div className="grid grid-cols-3 gap-2">
                    {TASK_TYPES.map(t => {
                      const Icon = t.icon;
                      const selected = form.type === t.value;
                      return (
                        <button
                          key={t.value}
                          type="button"
                          onClick={() => setForm(f => ({ ...f, type: t.value }))}
                          className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-all ${selected ? 'bg-[#00AF5C]/10 border-[#00AF5C]/40 text-[#00AF5C]' : 'bg-[#111111] border-[#2D2D2D] text-[#A0A0A0] hover:border-[#555555]'}`}
                        >
                          <Icon size={18} />
                          <span className="text-xs font-bold">{t.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {form.type === 'command' && (
                  <div>
                    <label className="text-xs font-bold text-[#A0A0A0] block mb-1.5">Console command</label>
                    <input
                      type="text"
                      value={form.command}
                      onChange={(e) => setForm(f => ({ ...f, command: e.target.value }))}
                      placeholder="say Server restarting in 5 minutes"
                      disabled={submitting}
                      className="w-full bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] focus:ring-4 focus:ring-[#00AF5C]/10 rounded-xl px-3 py-2.5 text-sm text-[#FFFFFF] outline-none transition-all font-mono placeholder-[#555555]"
                    />
                    <p className="text-[10px] text-[#555555] mt-1">Leading slash is optional. Runs only if the server is online.</p>
                  </div>
                )}

                <div>
                  <label className="text-xs font-bold text-[#A0A0A0] block mb-1.5">Time</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={form.hour}
                      onChange={(e) => setForm(f => ({ ...f, hour: Math.max(0, Math.min(23, Number(e.target.value) || 0)) }))}
                      className="w-20 bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] focus:ring-4 focus:ring-[#00AF5C]/10 rounded-xl px-3 py-2.5 text-sm text-[#FFFFFF] outline-none transition-all tabular-nums text-center"
                    />
                    <span className="text-[#555555] font-bold">:</span>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={form.minute}
                      onChange={(e) => setForm(f => ({ ...f, minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) }))}
                      className="w-20 bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] focus:ring-4 focus:ring-[#00AF5C]/10 rounded-xl px-3 py-2.5 text-sm text-[#FFFFFF] outline-none transition-all tabular-nums text-center"
                    />
                    <span className="text-xs text-[#555555] ml-2">24-hour, server local time</span>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-bold text-[#A0A0A0] block mb-1.5">Days <span className="text-[#555555] font-normal">(leave blank for every day)</span></label>
                  <div className="flex gap-1.5">
                    {DAYS.map(d => {
                      const selected = form.days.includes(d.value);
                      return (
                        <Tooltip key={d.value} content={d.label}>
                          <button
                            type="button"
                            onClick={() => toggleDay(d.value)}
                            className={`w-9 h-9 rounded-lg text-xs font-bold transition-all border ${selected ? 'bg-[#00AF5C]/10 border-[#00AF5C]/40 text-[#00AF5C]' : 'bg-[#111111] border-[#2D2D2D] text-[#A0A0A0] hover:border-[#555555]'}`}
                          >
                            {d.short}
                          </button>
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>

                {formError && (
                  <div className="flex items-start gap-2 px-3 py-2 bg-[#FF5555]/10 border border-[#FF5555]/20 rounded-xl text-xs text-[#FF5555]">
                    <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
                    <span>{formError}</span>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3 pt-5 mt-5 border-t border-[#2D2D2D]">
                <button
                  onClick={() => setShowCreate(false)}
                  disabled={submitting}
                  className="px-4 py-2 bg-[#111111] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#FFFFFF] rounded-xl text-sm font-bold transition-all duration-200 disabled:opacity-50 hover:scale-[1.02] active:scale-95"
                >
                  Cancel
                </button>
                <button
                  onClick={submitCreate}
                  disabled={submitting || !form.name.trim()}
                  className="px-4 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-sm font-bold transition-all duration-200 flex items-center gap-2 disabled:opacity-50 hover:scale-[1.02] active:scale-95"
                >
                  {submitting && <Loader2 size={14} className="animate-spin" />}
                  {submitting ? 'Creating...' : 'Create Task'}
                </button>
              </div>
            </motion.div>
          </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>
    </div>
  );
}
