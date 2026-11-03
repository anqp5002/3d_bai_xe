/** Lưu/mở kịch bản + nạp K1–K8 (FE §2, §5; P9a đã sinh mẫu). */

import { useState } from 'react';
import { useSimStore } from '../store/simStore';

export function ScenarioPanel() {
  const scenarioName = useSimStore((store) => store.scenarioName);
  const setScenarioName = useSimStore((store) => store.setScenarioName);
  const saveScenario = useSimStore((store) => store.saveScenario);
  const openScenario = useSimStore((store) => store.openScenario);
  const loadTemplate = useSimStore((store) => store.loadTemplate);
  const refreshLibrary = useSimStore((store) => store.refreshLibrary);
  const templates = useSimStore((store) => store.templates);
  const savedScenarios = useSimStore((store) => store.savedScenarios);
  const loading = useSimStore((store) => store.loading);

  const [templateId, setTemplateId] = useState('K1');

  return (
    <section className="panel-section">
      <h2>Kịch bản</h2>

      <label className="field">
        <span>Tên kịch bản</span>
        <input
          type="text"
          value={scenarioName}
          onChange={(event) => setScenarioName(event.target.value)}
          placeholder="scenario-1"
        />
      </label>
      <p className="hint">Chỉ A-Z a-z 0-9 _ - (không dấu cách).</p>

      <div className="button-row">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            void saveScenario(scenarioName);
          }}
          disabled={loading}
        >
          Lưu
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void openScenario(scenarioName);
          }}
          disabled={loading}
        >
          Mở
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void refreshLibrary();
          }}
          disabled={loading}
        >
          Làm mới
        </button>
      </div>

      <h3>K1–K8</h3>
      <div className="field-row compact">
        <label className="field">
          <span>Mẫu</span>
          <select
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
          >
            {(templates.length === 0
              ? Array.from({ length: 8 }, (_, index) => ({
                  id: `K${String(index + 1)}`,
                  name: `K${String(index + 1)}`,
                  description: '',
                }))
              : templates
            ).map((template) => (
              <option key={template.id} value={template.id}>
                {template.id} — {template.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void loadTemplate(templateId);
          }}
          disabled={loading}
        >
          Nạp mẫu
        </button>
      </div>
      {templates.length === 0 && (
        <p className="hint">Chưa tải được danh sách mẫu — bấm “Làm mới”.</p>
      )}

      <h3>Đã lưu ({savedScenarios.length})</h3>
      <ul className="scenario-list">
        {savedScenarios.map((entry) => (
          <li key={entry.name}>
            <button
              type="button"
              className="scenario-row"
              onClick={() => {
                void openScenario(entry.name);
              }}
              disabled={loading}
            >
              <span>{entry.name}</span>
              <small>{entry.modified_at.replace('T', ' ').slice(0, 16)}</small>
            </button>
          </li>
        ))}
        {savedScenarios.length === 0 && (
          <li className="empty">Chưa có kịch bản nào trên BE.</li>
        )}
      </ul>
    </section>
  );
}
