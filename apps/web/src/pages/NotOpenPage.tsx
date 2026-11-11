import { Card, Empty, Typography } from 'antd';

/** 未开放模块的占位说明：不提供任何假操作或虚构数据。 */
export default function NotOpenPage({ title, note }: { title: string; note?: string }) {
  return (
    <Card size="small" title={title}>
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <div>
            <div>「{title}」尚未开放</div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {note ?? '该模块将在对应业务实现并通过验收后启用，当前不提供操作入口，也不展示占位数据。'}
            </Typography.Text>
          </div>
        }
      />
    </Card>
  );
}
