import { z } from "zod";
import { paginationSchema } from "./common";

export const getRecommendationsQuerySchema = paginationSchema.extend({
  cursor: z.string().min(1).optional(),
  snapshotId: z.string().min(1).optional(),
});
