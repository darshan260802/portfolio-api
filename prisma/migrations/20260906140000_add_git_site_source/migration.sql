-- CreateEnum
CREATE TYPE "SiteSource" AS ENUM ('TEMPLATE', 'GIT');

-- AlterTable
-- template_id becomes nullable: a site built from the user's own git
-- repository has no template. Existing rows all have one and keep it.
ALTER TABLE "site" ALTER COLUMN "template_id" DROP NOT NULL;

ALTER TABLE "site" ADD COLUMN     "source" "SiteSource" NOT NULL DEFAULT 'TEMPLATE',
ADD COLUMN     "git_repo_url" TEXT,
ADD COLUMN     "git_branch" TEXT,
ADD COLUMN     "install_command" TEXT,
ADD COLUMN     "build_command" TEXT,
ADD COLUMN     "build_dir" TEXT;

-- CreateTable
CREATE TABLE "site_env_var" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value_cipher" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_env_var_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_env_var_site_id_key_key" ON "site_env_var"("site_id", "key");

-- AddForeignKey
ALTER TABLE "site_env_var" ADD CONSTRAINT "site_env_var_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
