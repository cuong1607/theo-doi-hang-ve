"use client";

import { Pause, Play, PlayCircle, RefreshCw, RotateCcw, Timer } from "lucide-react";

import { LoadingButton } from "@/components/patterns/loading-button";
import { useAsyncAction } from "@/components/patterns/use-async-action";

import { recoverStaleJobsAction, runSchedulerOnceAction, runWorkerOnceAction, setShopSyncEnabledAction, syncShopNowAction } from "./actions";

export function GlobalRepairButtons() {
  const scheduler = useAsyncAction({ refresh: true });
  const worker = useAsyncAction({ refresh: true });
  const recover = useAsyncAction({ refresh: true });
  return (
    <>
      <LoadingButton variant="outline" loading={recover.pending} icon={<RotateCcw aria-hidden="true" />} onClick={() => recover.run(recoverStaleJobsAction)}>
        Thu hồi job treo
      </LoadingButton>
      <LoadingButton variant="outline" loading={worker.pending} icon={<PlayCircle aria-hidden="true" />} onClick={() => worker.run(runWorkerOnceAction)}>
        Chạy worker 1 lượt
      </LoadingButton>
      <LoadingButton loading={scheduler.pending} icon={<Timer aria-hidden="true" />} onClick={() => scheduler.run(runSchedulerOnceAction)}>
        Chạy scheduler 1 lần
      </LoadingButton>
    </>
  );
}

export function ShopRepairButtons({ shopId, syncEnabled }: { shopId: string; syncEnabled: boolean }) {
  const sync = useAsyncAction({ refresh: true });
  const toggle = useAsyncAction({ refresh: true });
  return (
    <div className="flex flex-wrap justify-end gap-1">
      <LoadingButton size="xs" variant="outline" loading={sync.pending} icon={<RefreshCw aria-hidden="true" />} onClick={() => sync.run(() => syncShopNowAction(shopId))}>
        Đồng bộ ngay
      </LoadingButton>
      <LoadingButton
        size="xs"
        variant={syncEnabled ? "ghost" : "outline"}
        loading={toggle.pending}
        icon={syncEnabled ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        onClick={() => toggle.run(() => setShopSyncEnabledAction(shopId, !syncEnabled))}
      >
        {syncEnabled ? "Tạm dừng" : "Bật lại"}
      </LoadingButton>
    </div>
  );
}
