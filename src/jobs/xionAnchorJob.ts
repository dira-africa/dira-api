import { xionService } from "../services/xionService";
import { Job } from "bullmq";

export async function processXionAnchor(job: Job) {
  console.log("Starting XION historical/catchup anchoring job...");
  const result = await xionService.anchorAllCompletedWeeks();
  console.log("Completed XION weekly anchoring:", result);
  return result;
}
