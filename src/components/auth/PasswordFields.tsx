import { INPUT_CLASS, LABEL_CLASS } from "./form-styles";

/**
 * The Password / Confirm password pair shared by SetupForm and RedeemForm. `idPrefix`
 * keeps each form's input ids unique on the page (e.g. "setup", "redeem") — the
 * accessible label text stays "Password" / "Confirm password" either way.
 */
export function PasswordFields({
  idPrefix,
  password,
  confirmPassword,
  onPasswordChange,
  onConfirmPasswordChange,
}: {
  idPrefix: string;
  password: string;
  confirmPassword: string;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
}) {
  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-password`} className={LABEL_CLASS}>
          Password
        </label>
        <input
          id={`${idPrefix}-password`}
          name="password"
          type="password"
          autoComplete="new-password"
          className={INPUT_CLASS}
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-confirm-password`} className={LABEL_CLASS}>
          Confirm password
        </label>
        <input
          id={`${idPrefix}-confirm-password`}
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          className={INPUT_CLASS}
          value={confirmPassword}
          onChange={(e) => onConfirmPasswordChange(e.target.value)}
          required
        />
      </div>
    </>
  );
}
