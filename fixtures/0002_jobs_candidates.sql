-- Deterministic fictional data; existing records and user edits are retained.
DO $$
DECLARE n integer; org uuid; item uuid; desired text;
BEGIN
 FOR n IN 1..8 LOOP
  org=CASE WHEN n<=4 THEN '00000000-0000-0000-0000-000000000011'::uuid ELSE '00000000-0000-0000-0000-000000000012'::uuid END;
  item=('30000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid;
  IF NOT EXISTS(SELECT 1 FROM jobs WHERE id=item) THEN
   INSERT INTO jobs(id,employer_org_id,employer_name,title,description,location,employment_type) SELECT item,org,name,'架空求人 '||n||'・開発スタッフ','架空の求人です。デモ用の開発業務を担当します。',CASE WHEN n%2=0 THEN '大阪（架空）' ELSE '東京（架空）' END,CASE WHEN n%2=0 THEN 'contract' ELSE 'full_time' END FROM organizations WHERE id=org;
   IF n%4<>3 THEN UPDATE jobs SET status='published',version=version+1,updated_at=now() WHERE id=item; END IF;
   IF n%4=0 THEN UPDATE jobs SET status='closed',version=version+1,updated_at=now() WHERE id=item; END IF;
  END IF;
 END LOOP;
 FOR n IN 1..6 LOOP
  org=CASE WHEN n<=3 THEN '00000000-0000-0000-0000-000000000001'::uuid ELSE '00000000-0000-0000-0000-000000000002'::uuid END;
  INSERT INTO candidates(id,agency_org_id,name,summary) VALUES(('40000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,org,'架空候補者 '||n,'すべて架空の経歴です。システム開発の操作デモに使用します。') ON CONFLICT DO NOTHING;
 END LOOP;
END $$;
