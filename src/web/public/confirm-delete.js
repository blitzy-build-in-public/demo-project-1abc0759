/*
 * Delete confirmation for the task list and the task edit page.
 *
 * Every Delete button carries `data-confirm-delete` and `data-task-title` and submits its form to
 * /tasks/:id/delete with the hidden `confirm` field empty. Without JavaScript the server answers
 * that request with its own "Delete this task?" page and deletes nothing. With this script a click
 * first asks window.confirm: OK sets `confirm` to `yes` and lets the browser submit the form as
 * usual, so the server deletes the task and redirects to the list; Cancel stops the submission.
 * Either way no task is deleted without an explicit confirmation.
 *
 * The script reads no token or cookie, makes no request of its own and creates no markup. One
 * delegated listener serves every row, so its cost does not grow with the length of the list.
 */
(function () {
  'use strict';

  const DELETE_BUTTON = '[data-confirm-delete]';

  /**
   * The `confirm` value the server accepts as the user's confirmation. A browser script imports
   * nothing, so this mirrors `DELETE_CONFIRMED` in src/web/validation/params.ts.
   */
  const CONFIRMED = 'yes';

  /**
   * The hidden `confirm` input of a form, or null when the form has none. The name mirrors
   * `DELETE_CONFIRM_FIELD` in src/web/validation/params.ts, which the server renders and reads.
   */
  function confirmFieldOf(form) {
    const field = form ? form.elements.namedItem('confirm') : null;
    return field instanceof HTMLInputElement ? field : null;
  }

  /**
   * Whether an element submits its form when activated. A button of type `button` or `reset`
   * would delete nothing, so asking for a confirmation there would be meaningless.
   */
  function isSubmitButton(element) {
    const isControl =
      element instanceof HTMLButtonElement || element instanceof HTMLInputElement;
    return isControl && element.type === 'submit';
  }

  /**
   * Asks for confirmation when a Delete button is activated. Enter and Space on a focused button
   * dispatch `click` too, so keyboard users get the same confirmation.
   */
  function onClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const button = target.closest(DELETE_BUTTON);
    if (!isSubmitButton(button) || event.defaultPrevented) {
      return;
    }
    const title = button.getAttribute('data-task-title') || '';
    // `button.form` is the form that owns the button, whether by ancestry or through a `form`
    // attribute; `closest('form')` would miss a button associated through the attribute.
    const field = confirmFieldOf(button.form);
    // window.confirm shows the title as plain text, so a title holding markup stays inert.
    if (!window.confirm('Delete "' + title + '"?')) {
      event.preventDefault();
      if (field) {
        field.value = '';
      }
      return;
    }
    // The click is left to run its default action: the native submission keeps this button as
    // its submitter, so its formaction and the form's hidden fields are what the server receives.
    if (field) {
      field.value = CONFIRMED;
    }
  }

  /**
   * Empties `confirm` on every form that owns a Delete button. A page restored from the
   * back/forward cache, or whose form state the browser restores, would otherwise still carry
   * the `yes` set before the last deletion. Forms without a Delete button, such as the server's
   * own confirmation form, are left alone.
   */
  function resetConfirmFields() {
    const forms = new Set();
    for (const button of document.querySelectorAll(DELETE_BUTTON)) {
      if (isSubmitButton(button) && button.form) {
        forms.add(button.form);
      }
    }
    for (const form of forms) {
      const field = confirmFieldOf(form);
      if (field) {
        field.value = '';
      }
    }
  }

  document.addEventListener('click', onClick);
  window.addEventListener('pageshow', resetConfirmFields);
})();
