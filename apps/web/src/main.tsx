import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import App from './App';
import './styles.css';

// 第十一轮：日历组件强制中文（1月 / 2月 ...）
dayjs.locale('zh-cn');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#2f5c9e',
          colorInfo: '#2f5c9e',
          borderRadius: 4,
          fontSize: 14,
          colorBgLayout: '#f4f6f9',
        },
        components: {
          Layout: { siderBg: '#1f3552', triggerBg: '#1f3552' },
          Menu: { darkItemBg: '#1f3552', darkItemSelectedBg: '#2f5c9e' },
        },
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);
