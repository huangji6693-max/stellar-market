import { updateMilestoneSchema } from "../schemas/milestone";

describe("updateMilestoneSchema", () => {
  it("strips status so PUT /milestones/:id cannot bypass transition rules", () => {
    const parsed = updateMilestoneSchema.parse({
      title: "Updated title",
      status: "APPROVED",
    });
    expect(parsed).toEqual({ title: "Updated title" });
    expect("status" in parsed).toBe(false);
  });
});
