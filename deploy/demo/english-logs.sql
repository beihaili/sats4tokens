-- English log lines for the EU relay. new-api writes a few log contents in hard-coded Chinese (top-ups,
-- redemption codes, sign-up/invite bonuses, check-in, 2FA) and LogQuota appends " 额度" to amounts; users read
-- them on the Logs page. A BEFORE INSERT trigger rewrites them; the UPDATE at the end converts existing rows.
-- Only top-up/manage/system logs (types 1/3/4) are touched, never consume logs (type 2, the hot path).
-- Idempotent; sync-channels.sh applies it. Templates: new-api v1.0.0-rc.22 controller/topup.go, model/topup.go,
-- model/redemption.go, model/user.go, controller/checkin.go, controller/twofa.go, controller/secure_verification.go.
DROP TRIGGER IF EXISTS logs_en;
DROP FUNCTION IF EXISTS logs_en;

DELIMITER //
CREATE FUNCTION logs_en(s LONGTEXT CHARSET utf8mb4) RETURNS LONGTEXT CHARSET utf8mb4 DETERMINISTIC NO SQL
BEGIN
  DECLARE m VARCHAR(64);
  IF s IS NULL OR CHAR_LENGTH(s) = LENGTH(s) THEN RETURN s; END IF; -- plain ASCII: nothing to translate
  -- amounts: "€2.000000 额度" → "€2.00" (rounded, like the wallet); tokens display "123 点额度" → "123 tokens"
  SET s = REPLACE(REPLACE(s, ' 点额度', ' tokens'), ' 额度', '');
  amounts: LOOP -- each pass rounds one distinct number after a currency symbol or "支付金额："
    SET m = REGEXP_SUBSTR(s, '(?<=[€¥＄$¤：])[0-9]+[.][0-9]{3,}');
    IF m IS NULL THEN LEAVE amounts; END IF;
    SET s = REPLACE(s, m, ROUND(CAST(m AS DECIMAL(30, 6)), 2));
  END LOOP;
  SET s = REGEXP_REPLACE(s, '^使用在线充值成功，充值金额: (€.*)，支付金额：([0-9.]+)$', 'Top-up: +$1 (paid €$2)');
  SET s = REGEXP_REPLACE(s, '^使用在线充值成功，充值金额: (.*)，支付金额：([0-9.]+)$', 'Top-up: +$1 (paid $2)');
  SET s = REGEXP_REPLACE(s, '^管理员补单成功，充值金额: (.*)，支付金额：([0-9.]+)$', 'Top-up completed by admin: +$1 (paid $2)');
  SET s = REGEXP_REPLACE(s, '^通过兑换码充值 (.*)，兑换码ID ([0-9]+)$', 'Redemption code #$2: +$1');
  SET s = REGEXP_REPLACE(s, '^新用户注册赠送 ', 'Sign-up bonus: +');
  SET s = REGEXP_REPLACE(s, '^使用邀请码赠送 ', 'Invitation code bonus: +');
  SET s = REGEXP_REPLACE(s, '^邀请用户赠送 ', 'Referral bonus: +');
  SET s = REGEXP_REPLACE(s, '^用户签到，获得额度 ', 'Daily check-in: +');
  RETURN CASE s
    WHEN '开始设置两步验证' THEN 'Started 2FA setup'
    WHEN '成功启用两步验证' THEN '2FA enabled'
    WHEN '禁用两步验证' THEN '2FA disabled'
    WHEN '重新生成两步验证备用码' THEN '2FA backup codes regenerated'
    WHEN '通用安全验证成功 (验证方式: 2FA)' THEN 'Security verification passed (2FA)'
    ELSE s END;
END//

CREATE TRIGGER logs_en BEFORE INSERT ON logs FOR EACH ROW
BEGIN
  IF NEW.type IN (1, 3, 4) THEN SET NEW.content = logs_en(NEW.content); END IF;
END//
DELIMITER ;

UPDATE logs SET content = logs_en(content) WHERE type IN (1, 3, 4) AND CHAR_LENGTH(content) <> LENGTH(content);
