-- SECURITY DEFINER function to create org + add creator as admin (bypasses RLS chicken-and-egg)
DROP FUNCTION IF EXISTS create_organization(TEXT, UUID);

CREATE FUNCTION create_organization(p_org_name TEXT, p_creator_uid UUID)
RETURNS TABLE(org_id UUID, org_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_new_org_id UUID;
BEGIN
  INSERT INTO public.organizations (name)
  VALUES (p_org_name)
  RETURNING id INTO v_new_org_id;
  
  INSERT INTO public.organization_members (org_id, user_id, role, invited_by)
  VALUES (v_new_org_id, p_creator_uid, 'admin', p_creator_uid);
  
  org_id := v_new_org_id;
  org_name := p_org_name;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION create_organization(TEXT, UUID) TO authenticated;
