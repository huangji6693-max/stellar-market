import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { asyncHandler } from "../middleware/error";
import { cache } from "../lib/cache";
import { JOB_CATEGORIES } from "../constants/categories";

const router = Router();
const prisma = new PrismaClient();

const VALID_CATEGORIES = JOB_CATEGORIES;

const CATEGORY_ICONS: Record<string, string> = {
  Frontend: "Monitor",
  Backend: "Server",
  "Smart Contract": "FileCode",
  Design: "Palette",
  Mobile: "Smartphone",
  Documentation: "FileText",
  DevOps: "Container",
};

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  Frontend:
    "Find expert frontend developers for React, Next.js, Vue, and modern web applications on StellarMarket.",
  Backend:
    "Hire skilled backend developers specializing in Node.js, Python, databases, and API development.",
  "Smart Contract":
    "Connect with Soroban and Stellar smart contract developers for blockchain solutions.",
  Design:
    "Discover talented UI/UX designers, graphic designers, and brand specialists.",
  Mobile:
    "Find mobile app developers for iOS, Android, and cross-platform development.",
  Documentation:
    "Hire technical writers and documentation specialists for your project.",
  DevOps:
    "Find DevOps engineers for CI/CD, cloud infrastructure, and platform automation.",
};

function slugToCategory(slug: string): string | null {
  const category = VALID_CATEGORIES.find(
    (cat) => cat.toLowerCase().replace(/\s+/g, "-") === slug.toLowerCase(),
  );
  return category ?? null;
}

function categoryToSlug(category: string): string {
  return category.toLowerCase().replace(/\s+/g, "-");
}

router.get(
  "/",
  asyncHandler(async (_req: Request, res: Response) => {
    const { data } = await cache("categories:all", 300, async () => {
      // Single GROUP BY query instead of one COUNT per category.
      const counts = await prisma.$queryRaw<
        Array<{ category: string; jobCount: number }>
      >`
        SELECT LOWER(category) AS category, COUNT(*)::int AS "jobCount"
        FROM "Job"
        WHERE status = 'OPEN'
        GROUP BY LOWER(category)
      `;
      const jobCountByCategory = new Map(
        counts.map((row) => [row.category, row.jobCount]),
      );
      return VALID_CATEGORIES.map((name) => ({
        name,
        slug: categoryToSlug(name),
        icon: CATEGORY_ICONS[name] ?? "Briefcase",
        description: CATEGORY_DESCRIPTIONS[name] ?? "",
        jobCount: jobCountByCategory.get(name.toLowerCase()) ?? 0,
      }));
    });
    res.json({ data });
  }),
);

router.get(
  "/:slug",
  asyncHandler(async (req: Request, res: Response) => {
    const slug = req.params.slug as string;
    const categoryName = slugToCategory(slug);

    if (!categoryName) {
      return res.status(404).json({ error: "Category not found." });
    }

    // Use the canonical slug (not the raw request param) so every casing
    // variant shares one cache entry and matches GET /categories.
    const canonicalSlug = categoryToSlug(categoryName);
    const cacheKey = `category:${canonicalSlug}`;
    const { data } = await cache(cacheKey, 300, async () => {
      const jobCount = await prisma.job.count({
        where: {
          category: { equals: categoryName, mode: "insensitive" },
          status: "OPEN",
        },
      });

      const freelancerCount = await prisma.user.count({
        where: {
          role: "FREELANCER",
          skills: { has: categoryName },
        },
      });

      return {
        name: categoryName,
        slug: canonicalSlug,
        icon: CATEGORY_ICONS[categoryName] ?? "Briefcase",
        description: CATEGORY_DESCRIPTIONS[categoryName] ?? "",
        jobCount,
        freelancerCount,
      };
    });

    res.json({ data });
  }),
);

export default router;
