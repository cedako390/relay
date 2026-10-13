-- Sessions that were written to before `prompted_at` existed still belong in the sidebar history.
UPDATE `sessions` SET `prompted_at` = (SELECT MIN(`ts`) FROM `events` WHERE `events`.`session_id` = `sessions`.`id` AND `events`.`type` = 'UserPromptSubmit') WHERE `prompted_at` IS NULL;
