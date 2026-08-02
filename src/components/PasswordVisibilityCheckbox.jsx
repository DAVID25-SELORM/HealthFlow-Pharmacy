const PasswordVisibilityCheckbox = ({ id, visible, onChange }) => (
  <label className="password-visibility-checkbox" htmlFor={id}>
    <input
      id={id}
      type="checkbox"
      checked={visible}
      onChange={(e) => onChange(e.target.checked)}
    />
    Show password
  </label>
)

export default PasswordVisibilityCheckbox
