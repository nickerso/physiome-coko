ALTER TABLE "submission"
    ADD COLUMN "suitable_for_physiome" boolean,
    ADD COLUMN "manuscript_formatted" boolean,
    ADD COLUMN "model_impl_executable" boolean,
    ADD COLUMN "reprod_goal_achieved" boolean,
    ADD COLUMN "model_reproducible" boolean,
    ADD COLUMN "modification_explained" boolean,
    ADD COLUMN "model_appropriate_standards" boolean,
    ADD COLUMN "param_source_stated" boolean,
    ADD COLUMN "provenance_clear" boolean,
    ADD COLUMN "overlap_paper_manuscript_code" boolean,
    ADD COLUMN "article_fit_for_publication" boolean;
