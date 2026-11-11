import { createContext, useContext, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout, Spin } from 'antd';
import { api, type SessionInfo } from './api';
import AppHeader from './components/AppHeader';
import ProjectLayout from './project/ProjectLayout';
import LoginPage from './pages/LoginPage';
import ProjectsPage from './pages/ProjectsPage';
import ProjectFormPage from './pages/ProjectFormPage';
import ProjectOverviewPage from './pages/ProjectOverviewPage';
import CostWorkbenchPage from './pages/CostWorkbenchPage';
import ProcessCostPage from './pages/ProcessCostPage';
import BoqItemsPage from './pages/BoqItemsPage';
import ProjectSettingsPage from './pages/ProjectSettingsPage';
import SystemSettingsPage from './pages/SystemSettingsPage';
import NotOpenPage from './pages/NotOpenPage';

const SessionContext = createContext<SessionInfo | null>(null);
export function useSession(): SessionInfo {
  const value = useContext(SessionContext);
  if (!value) throw new Error('会话尚未加载');
  return value;
}

/** 项目列表等全局页面的外层布局：仅顶部栏，无项目侧栏。 */
function ListShell({ onLogout, children }: { onLogout: () => void; children: React.ReactNode }) {
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <AppHeader onLogout={onLogout} />
      <Layout.Content style={{ padding: 20 }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>{children}</div>
      </Layout.Content>
    </Layout>
  );
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const session = useSession();
  return (
    <>
      {session.isDemo && (
        <div className="demo-banner">
          <span>●</span>
          <span>{session.demoBannerText}</span>
          <span className="muted">｜环境：{session.appEnv}</span>
        </div>
      )}
      <Routes>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route
          path="/projects"
          element={
            <ListShell onLogout={onLogout}>
              <ProjectsPage />
            </ListShell>
          }
        />
        <Route
          path="/projects/new"
          element={
            <ListShell onLogout={onLogout}>
              <ProjectFormPage mode="create" />
            </ListShell>
          }
        />
        <Route
          path="/settings/system"
          element={
            <ListShell onLogout={onLogout}>
              <SystemSettingsPage />
            </ListShell>
          }
        />
        <Route path="/projects/:id" element={<ProjectLayout onLogout={onLogout} />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<ProjectOverviewPage />} />
          <Route path="cost" element={<Navigate to="comparison" replace />} />
          <Route path="cost/comparison" element={<CostWorkbenchPage />} />
          <Route path="cost/process" element={<ProcessCostPage />} />
          <Route path="revenue" element={<Navigate to="boq" replace />} />
          <Route path="revenue/boq" element={<BoqItemsPage />} />
          <Route path="prices" element={<NotOpenPage title="价格资料" />} />
          <Route path="matters" element={<NotOpenPage title="事项与审批" />} />
          <Route path="reports" element={<NotOpenPage title="报告中心" />} />
          <Route path="settings" element={<ProjectSettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </>
  );
}

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .me()
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Spin size="large" tip="正在加载平台…" />
      </div>
    );
  }

  return (
    <SessionContext.Provider value={session as SessionInfo}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage onLoggedIn={setSession} />} />
          <Route
            path="/*"
            element={
              session ? (
                <Shell
                  onLogout={async () => {
                    await api.logout().catch(() => undefined);
                    setSession(null);
                    window.location.href = '/login';
                  }}
                />
              ) : (
                <Navigate to="/login" replace />
              )
            }
          />
        </Routes>
      </BrowserRouter>
    </SessionContext.Provider>
  );
}
