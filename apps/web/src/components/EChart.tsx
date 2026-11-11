import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

// 按需注册，避免整包引入
echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer,
]);

type ChartInstance = ReturnType<typeof echarts.init>;

/**
 * ECharts 轻量封装：option 变化时整体重设（notMerge），
 * 容器尺寸变化时自适应，卸载时销毁实例。
 */
export default function EChart({
  option,
  height = 280,
  empty = false,
}: {
  option: EChartsCoreOption;
  height?: number;
  empty?: boolean;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ChartInstance | null>(null);

  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const chart = echarts.init(el);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.setOption(option, { notMerge: true });
  }, [option]);

  return (
    <div
      ref={holderRef}
      style={{
        width: '100%',
        height,
        opacity: empty ? 0.45 : 1,
        transition: 'opacity .2s',
      }}
    />
  );
}
