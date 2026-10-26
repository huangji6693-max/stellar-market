import { getServicesQuerySchema } from "../schemas/service";

describe("getServicesQuerySchema price range", () => {
  it("rejects an inverted price range", () => {
    const result = getServicesQuerySchema.safeParse({
      minPrice: "100",
      maxPrice: "10",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["minPrice"]);
    }
  });

  it("accepts a valid price range", () => {
    expect(
      getServicesQuerySchema.safeParse({ minPrice: "10", maxPrice: "100" })
        .success
    ).toBe(true);
    expect(
      getServicesQuerySchema.safeParse({ minPrice: "10", maxPrice: "10" })
        .success
    ).toBe(true);
  });

  it("accepts single-sided price filters", () => {
    expect(
      getServicesQuerySchema.safeParse({ minPrice: "100" }).success
    ).toBe(true);
    expect(
      getServicesQuerySchema.safeParse({ maxPrice: "10" }).success
    ).toBe(true);
  });
});
